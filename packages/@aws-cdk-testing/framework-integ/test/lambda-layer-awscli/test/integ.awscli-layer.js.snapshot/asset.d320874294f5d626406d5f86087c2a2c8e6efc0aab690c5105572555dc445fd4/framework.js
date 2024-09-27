"use strict";
/* eslint-disable max-len */
/* eslint-disable no-console */
const cfnResponse = require("./cfn-response");
const consts = require("./consts");
const outbound_1 = require("./outbound");
const util_1 = require("./util");
/**
 * The main runtime entrypoint of the async custom resource lambda function.
 *
 * Any lifecycle event changes to the custom resources will invoke this handler, which will, in turn,
 * interact with the user-defined `onEvent` and `isComplete` handlers.
 *
 * This function will always succeed. If an error occurs, it is logged but an error is not thrown.
 *
 * @param cfnRequest The cloudformation custom resource event.
 */
async function onEvent(cfnRequest) {
    const sanitizedRequest = { ...cfnRequest, ResponseURL: '...' };
    (0, util_1.log)('onEventHandler', sanitizedRequest);
    cfnRequest.ResourceProperties = cfnRequest.ResourceProperties || {};
    const onEventResult = await invokeUserFunction(consts.USER_ON_EVENT_FUNCTION_ARN_ENV, sanitizedRequest, cfnRequest.ResponseURL);
    if (onEventResult?.NoEcho) {
        (0, util_1.log)('redacted onEvent returned:', cfnResponse.redactDataFromPayload(onEventResult));
    }
    else {
        (0, util_1.log)('onEvent returned:', onEventResult);
    }
    // merge the request and the result from onEvent to form the complete resource event
    // this also performs validation.
    const resourceEvent = createResponseEvent(cfnRequest, onEventResult);
    const sanitizedEvent = { ...resourceEvent, ResponseURL: '...' };
    if (onEventResult?.NoEcho) {
        (0, util_1.log)('readacted event:', cfnResponse.redactDataFromPayload(sanitizedEvent));
    }
    else {
        (0, util_1.log)('event:', sanitizedEvent);
    }
    // determine if this is an async provider based on whether we have an isComplete handler defined.
    // if it is not defined, then we are basically ready to return a positive response.
    if (!process.env[consts.USER_IS_COMPLETE_FUNCTION_ARN_ENV]) {
        return cfnResponse.submitResponse('SUCCESS', resourceEvent, { noEcho: resourceEvent.NoEcho });
    }
    // ok, we are not complete, so kick off the waiter workflow
    const waiter = {
        stateMachineArn: (0, util_1.getEnv)(consts.WAITER_STATE_MACHINE_ARN_ENV),
        name: resourceEvent.RequestId,
        input: JSON.stringify(resourceEvent),
    };
    (0, util_1.log)('starting waiter', {
        stateMachineArn: (0, util_1.getEnv)(consts.WAITER_STATE_MACHINE_ARN_ENV),
        name: resourceEvent.RequestId,
    });
    // kick off waiter state machine
    await (0, outbound_1.startExecution)(waiter);
}
// invoked a few times until `complete` is true or until it times out.
async function isComplete(event) {
    const sanitizedRequest = { ...event, ResponseURL: '...' };
    if (event?.NoEcho) {
        (0, util_1.log)('redacted isComplete request', cfnResponse.redactDataFromPayload(sanitizedRequest));
    }
    else {
        (0, util_1.log)('isComplete', sanitizedRequest);
    }
    const isCompleteResult = await invokeUserFunction(consts.USER_IS_COMPLETE_FUNCTION_ARN_ENV, sanitizedRequest, event.ResponseURL);
    if (event?.NoEcho) {
        (0, util_1.log)('redacted user isComplete returned:', cfnResponse.redactDataFromPayload(isCompleteResult));
    }
    else {
        (0, util_1.log)('user isComplete returned:', isCompleteResult);
    }
    // if we are not complete, return false, and don't send a response back.
    if (!isCompleteResult.IsComplete) {
        if (isCompleteResult.Data && Object.keys(isCompleteResult.Data).length > 0) {
            throw new Error('"Data" is not allowed if "IsComplete" is "False"');
        }
        // This must be the full event, it will be deserialized in `onTimeout` to send the response to CloudFormation
        throw new cfnResponse.Retry(JSON.stringify(event));
    }
    const response = {
        ...event,
        ...isCompleteResult,
        Data: {
            ...event.Data,
            ...isCompleteResult.Data,
        },
    };
    await cfnResponse.submitResponse('SUCCESS', response, { noEcho: event.NoEcho });
}
// invoked when completion retries are exhaused.
async function onTimeout(timeoutEvent) {
    (0, util_1.log)('timeoutHandler', timeoutEvent);
    const isCompleteRequest = JSON.parse(JSON.parse(timeoutEvent.Cause).errorMessage);
    await cfnResponse.submitResponse('FAILED', isCompleteRequest, {
        reason: 'Operation timed out',
    });
}
async function invokeUserFunction(functionArnEnv, sanitizedPayload, responseUrl) {
    const functionArn = (0, util_1.getEnv)(functionArnEnv);
    (0, util_1.log)(`executing user function ${functionArn} with payload`, sanitizedPayload);
    // transient errors such as timeouts, throttling errors (429), and other
    // errors that aren't caused by a bad request (500 series) are retried
    // automatically by the JavaScript SDK.
    const resp = await (0, outbound_1.invokeFunction)({
        FunctionName: functionArn,
        // Cannot strip 'ResponseURL' here as this would be a breaking change even though the downstream CR doesn't need it
        Payload: JSON.stringify({ ...sanitizedPayload, ResponseURL: responseUrl }),
    });
    (0, util_1.log)('user function response:', resp, typeof (resp));
    // ParseJsonPayload is very defensive. It should not be possible for `Payload`
    // to be anything other than a JSON encoded string (or intarray). Something weird is
    // going on if that happens. Still, we should do our best to survive it.
    const jsonPayload = (0, util_1.parseJsonPayload)(resp.Payload);
    if (resp.FunctionError) {
        (0, util_1.log)('user function threw an error:', resp.FunctionError);
        const errorMessage = jsonPayload.errorMessage || 'error';
        // parse function name from arn
        // arn:${Partition}:lambda:${Region}:${Account}:function:${FunctionName}
        const arn = functionArn.split(':');
        const functionName = arn[arn.length - 1];
        // append a reference to the log group.
        const message = [
            errorMessage,
            '',
            `Logs: /aws/lambda/${functionName}`, // cloudwatch log group
            '',
        ].join('\n');
        const e = new Error(message);
        // the output that goes to CFN is what's in `stack`, not the error message.
        // if we have a remote trace, construct a nice message with log group information
        if (jsonPayload.trace) {
            // skip first trace line because it's the message
            e.stack = [message, ...jsonPayload.trace.slice(1)].join('\n');
        }
        throw e;
    }
    return jsonPayload;
}
function createResponseEvent(cfnRequest, onEventResult) {
    //
    // validate that onEventResult always includes a PhysicalResourceId
    onEventResult = onEventResult || {};
    // if physical ID is not returned, we have some defaults for you based
    // on the request type.
    const physicalResourceId = onEventResult.PhysicalResourceId || defaultPhysicalResourceId(cfnRequest);
    // if we are in DELETE and physical ID was changed, it's an error.
    if (cfnRequest.RequestType === 'Delete' && physicalResourceId !== cfnRequest.PhysicalResourceId) {
        throw new Error(`DELETE: cannot change the physical resource ID from "${cfnRequest.PhysicalResourceId}" to "${onEventResult.PhysicalResourceId}" during deletion`);
    }
    // if we are in UPDATE and physical ID was changed, it's a replacement (just log)
    if (cfnRequest.RequestType === 'Update' && physicalResourceId !== cfnRequest.PhysicalResourceId) {
        (0, util_1.log)(`UPDATE: changing physical resource ID from "${cfnRequest.PhysicalResourceId}" to "${onEventResult.PhysicalResourceId}"`);
    }
    // merge request event and result event (result prevails).
    return {
        ...cfnRequest,
        ...onEventResult,
        PhysicalResourceId: physicalResourceId,
    };
}
/**
 * Calculates the default physical resource ID based in case user handler did
 * not return a PhysicalResourceId.
 *
 * For "CREATE", it uses the RequestId.
 * For "UPDATE" and "DELETE" and returns the current PhysicalResourceId (the one provided in `event`).
 */
function defaultPhysicalResourceId(req) {
    switch (req.RequestType) {
        case 'Create':
            return req.RequestId;
        case 'Update':
        case 'Delete':
            return req.PhysicalResourceId;
        default:
            throw new Error(`Invalid "RequestType" in request "${JSON.stringify(req)}"`);
    }
}
module.exports = {
    [consts.FRAMEWORK_ON_EVENT_HANDLER_NAME]: cfnResponse.safeHandler(onEvent),
    [consts.FRAMEWORK_IS_COMPLETE_HANDLER_NAME]: cfnResponse.safeHandler(isComplete),
    [consts.FRAMEWORK_ON_TIMEOUT_HANDLER_NAME]: onTimeout,
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnJhbWV3b3JrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZnJhbWV3b3JrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSw0QkFBNEI7QUFDNUIsK0JBQStCO0FBQy9CLDhDQUE4QztBQUM5QyxtQ0FBbUM7QUFDbkMseUNBQTREO0FBQzVELGlDQUF1RDtBQVV2RDs7Ozs7Ozs7O0dBU0c7QUFDSCxLQUFLLFVBQVUsT0FBTyxDQUFDLFVBQXVEO0lBQzVFLE1BQU0sZ0JBQWdCLEdBQUcsRUFBRSxHQUFHLFVBQVUsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFXLENBQUM7SUFDeEUsSUFBQSxVQUFHLEVBQUMsZ0JBQWdCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztJQUV4QyxVQUFVLENBQUMsa0JBQWtCLEdBQUcsVUFBVSxDQUFDLGtCQUFrQixJQUFJLEVBQUcsQ0FBQztJQUVyRSxNQUFNLGFBQWEsR0FBRyxNQUFNLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyw4QkFBOEIsRUFBRSxnQkFBZ0IsRUFBRSxVQUFVLENBQUMsV0FBVyxDQUFvQixDQUFDO0lBQ25KLElBQUksYUFBYSxFQUFFLE1BQU0sRUFBRSxDQUFDO1FBQzFCLElBQUEsVUFBRyxFQUFDLDRCQUE0QixFQUFFLFdBQVcsQ0FBQyxxQkFBcUIsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7U0FBTSxDQUFDO1FBQ04sSUFBQSxVQUFHLEVBQUMsbUJBQW1CLEVBQUUsYUFBYSxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUVELG9GQUFvRjtJQUNwRixpQ0FBaUM7SUFDakMsTUFBTSxhQUFhLEdBQUcsbUJBQW1CLENBQUMsVUFBVSxFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQ3JFLE1BQU0sY0FBYyxHQUFHLEVBQUUsR0FBRyxhQUFhLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ2hFLElBQUksYUFBYSxFQUFFLE1BQU0sRUFBRSxDQUFDO1FBQzFCLElBQUEsVUFBRyxFQUFDLGtCQUFrQixFQUFFLFdBQVcsQ0FBQyxxQkFBcUIsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDO0lBQzdFLENBQUM7U0FBTSxDQUFDO1FBQ04sSUFBQSxVQUFHLEVBQUMsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFFRCxpR0FBaUc7SUFDakcsbUZBQW1GO0lBQ25GLElBQUksQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxpQ0FBaUMsQ0FBQyxFQUFFLENBQUM7UUFDM0QsT0FBTyxXQUFXLENBQUMsY0FBYyxDQUFDLFNBQVMsRUFBRSxhQUFhLEVBQUUsRUFBRSxNQUFNLEVBQUUsYUFBYSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDaEcsQ0FBQztJQUVELDJEQUEyRDtJQUMzRCxNQUFNLE1BQU0sR0FBRztRQUNiLGVBQWUsRUFBRSxJQUFBLGFBQU0sRUFBQyxNQUFNLENBQUMsNEJBQTRCLENBQUM7UUFDNUQsSUFBSSxFQUFFLGFBQWEsQ0FBQyxTQUFTO1FBQzdCLEtBQUssRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQztLQUNyQyxDQUFDO0lBRUYsSUFBQSxVQUFHLEVBQUMsaUJBQWlCLEVBQUU7UUFDckIsZUFBZSxFQUFFLElBQUEsYUFBTSxFQUFDLE1BQU0sQ0FBQyw0QkFBNEIsQ0FBQztRQUM1RCxJQUFJLEVBQUUsYUFBYSxDQUFDLFNBQVM7S0FDOUIsQ0FBQyxDQUFDO0lBRUgsZ0NBQWdDO0lBQ2hDLE1BQU0sSUFBQSx5QkFBYyxFQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUM7QUFFRCxzRUFBc0U7QUFDdEUsS0FBSyxVQUFVLFVBQVUsQ0FBQyxLQUFrRDtJQUMxRSxNQUFNLGdCQUFnQixHQUFHLEVBQUUsR0FBRyxLQUFLLEVBQUUsV0FBVyxFQUFFLEtBQUssRUFBVyxDQUFDO0lBQ25FLElBQUksS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDO1FBQ2xCLElBQUEsVUFBRyxFQUFDLDZCQUE2QixFQUFFLFdBQVcsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7SUFDMUYsQ0FBQztTQUFNLENBQUM7UUFDTixJQUFBLFVBQUcsRUFBQyxZQUFZLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBRUQsTUFBTSxnQkFBZ0IsR0FBRyxNQUFNLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxpQ0FBaUMsRUFBRSxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsV0FBVyxDQUF1QixDQUFDO0lBQ3ZKLElBQUksS0FBSyxFQUFFLE1BQU0sRUFBRSxDQUFDO1FBQ2xCLElBQUEsVUFBRyxFQUFDLG9DQUFvQyxFQUFFLFdBQVcsQ0FBQyxxQkFBcUIsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7SUFDakcsQ0FBQztTQUFNLENBQUM7UUFDTixJQUFBLFVBQUcsRUFBQywyQkFBMkIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3JELENBQUM7SUFFRCx3RUFBd0U7SUFDeEUsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQ2pDLElBQUksZ0JBQWdCLENBQUMsSUFBSSxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzNFLE1BQU0sSUFBSSxLQUFLLENBQUMsa0RBQWtELENBQUMsQ0FBQztRQUN0RSxDQUFDO1FBRUQsNkdBQTZHO1FBQzdHLE1BQU0sSUFBSSxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUNyRCxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQUc7UUFDZixHQUFHLEtBQUs7UUFDUixHQUFHLGdCQUFnQjtRQUNuQixJQUFJLEVBQUU7WUFDSixHQUFHLEtBQUssQ0FBQyxJQUFJO1lBQ2IsR0FBRyxnQkFBZ0IsQ0FBQyxJQUFJO1NBQ3pCO0tBQ0YsQ0FBQztJQUVGLE1BQU0sV0FBVyxDQUFDLGNBQWMsQ0FBQyxTQUFTLEVBQUUsUUFBUSxFQUFFLEVBQUUsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQ2xGLENBQUM7QUFFRCxnREFBZ0Q7QUFDaEQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxZQUFpQjtJQUN4QyxJQUFBLFVBQUcsRUFBQyxnQkFBZ0IsRUFBRSxZQUFZLENBQUMsQ0FBQztJQUVwQyxNQUFNLGlCQUFpQixHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUMsWUFBWSxDQUFnRCxDQUFDO0lBQ2pJLE1BQU0sV0FBVyxDQUFDLGNBQWMsQ0FBQyxRQUFRLEVBQUUsaUJBQWlCLEVBQUU7UUFDNUQsTUFBTSxFQUFFLHFCQUFxQjtLQUM5QixDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLGtCQUFrQixDQUFtQyxjQUFzQixFQUFFLGdCQUFtQixFQUFFLFdBQW1CO0lBQ2xJLE1BQU0sV0FBVyxHQUFHLElBQUEsYUFBTSxFQUFDLGNBQWMsQ0FBQyxDQUFDO0lBQzNDLElBQUEsVUFBRyxFQUFDLDJCQUEyQixXQUFXLGVBQWUsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBRTdFLHdFQUF3RTtJQUN4RSxzRUFBc0U7SUFDdEUsdUNBQXVDO0lBQ3ZDLE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBQSx5QkFBYyxFQUFDO1FBQ2hDLFlBQVksRUFBRSxXQUFXO1FBRXpCLG1IQUFtSDtRQUNuSCxPQUFPLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEdBQUcsZ0JBQWdCLEVBQUUsV0FBVyxFQUFFLFdBQVcsRUFBRSxDQUFDO0tBQzNFLENBQUMsQ0FBQztJQUVILElBQUEsVUFBRyxFQUFDLHlCQUF5QixFQUFFLElBQUksRUFBRSxPQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUVuRCw4RUFBOEU7SUFDOUUsb0ZBQW9GO0lBQ3BGLHdFQUF3RTtJQUN4RSxNQUFNLFdBQVcsR0FBRyxJQUFBLHVCQUFnQixFQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNuRCxJQUFJLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztRQUN2QixJQUFBLFVBQUcsRUFBQywrQkFBK0IsRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUM7UUFFekQsTUFBTSxZQUFZLEdBQUcsV0FBVyxDQUFDLFlBQVksSUFBSSxPQUFPLENBQUM7UUFFekQsK0JBQStCO1FBQy9CLHdFQUF3RTtRQUN4RSxNQUFNLEdBQUcsR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ25DLE1BQU0sWUFBWSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBRXpDLHVDQUF1QztRQUN2QyxNQUFNLE9BQU8sR0FBRztZQUNkLFlBQVk7WUFDWixFQUFFO1lBQ0YscUJBQXFCLFlBQVksRUFBRSxFQUFFLHVCQUF1QjtZQUM1RCxFQUFFO1NBQ0gsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFYixNQUFNLENBQUMsR0FBRyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUU3QiwyRUFBMkU7UUFDM0UsaUZBQWlGO1FBQ2pGLElBQUksV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ3RCLGlEQUFpRDtZQUNqRCxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsT0FBTyxFQUFFLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDaEUsQ0FBQztRQUVELE1BQU0sQ0FBQyxDQUFDO0lBQ1YsQ0FBQztJQUVELE9BQU8sV0FBVyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLFVBQXVELEVBQUUsYUFBOEI7SUFDbEgsRUFBRTtJQUNGLG1FQUFtRTtJQUVuRSxhQUFhLEdBQUcsYUFBYSxJQUFJLEVBQUcsQ0FBQztJQUVyQyxzRUFBc0U7SUFDdEUsdUJBQXVCO0lBQ3ZCLE1BQU0sa0JBQWtCLEdBQUcsYUFBYSxDQUFDLGtCQUFrQixJQUFJLHlCQUF5QixDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBRXJHLGtFQUFrRTtJQUNsRSxJQUFJLFVBQVUsQ0FBQyxXQUFXLEtBQUssUUFBUSxJQUFJLGtCQUFrQixLQUFLLFVBQVUsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQ2hHLE1BQU0sSUFBSSxLQUFLLENBQUMsd0RBQXdELFVBQVUsQ0FBQyxrQkFBa0IsU0FBUyxhQUFhLENBQUMsa0JBQWtCLG1CQUFtQixDQUFDLENBQUM7SUFDckssQ0FBQztJQUVELGlGQUFpRjtJQUNqRixJQUFJLFVBQVUsQ0FBQyxXQUFXLEtBQUssUUFBUSxJQUFJLGtCQUFrQixLQUFLLFVBQVUsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQ2hHLElBQUEsVUFBRyxFQUFDLCtDQUErQyxVQUFVLENBQUMsa0JBQWtCLFNBQVMsYUFBYSxDQUFDLGtCQUFrQixHQUFHLENBQUMsQ0FBQztJQUNoSSxDQUFDO0lBRUQsMERBQTBEO0lBQzFELE9BQU87UUFDTCxHQUFHLFVBQVU7UUFDYixHQUFHLGFBQWE7UUFDaEIsa0JBQWtCLEVBQUUsa0JBQWtCO0tBQ3ZDLENBQUM7QUFDSixDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsU0FBUyx5QkFBeUIsQ0FBQyxHQUFnRDtJQUNqRixRQUFRLEdBQUcsQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUN4QixLQUFLLFFBQVE7WUFDWCxPQUFPLEdBQUcsQ0FBQyxTQUFTLENBQUM7UUFFdkIsS0FBSyxRQUFRLENBQUM7UUFDZCxLQUFLLFFBQVE7WUFDWCxPQUFPLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQztRQUVoQztZQUNFLE1BQU0sSUFBSSxLQUFLLENBQUMscUNBQXFDLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2pGLENBQUM7QUFDSCxDQUFDO0FBak5ELGlCQUFTO0lBQ1AsQ0FBQyxNQUFNLENBQUMsK0JBQStCLENBQUMsRUFBRSxXQUFXLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQztJQUMxRSxDQUFDLE1BQU0sQ0FBQyxrQ0FBa0MsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxXQUFXLENBQUMsVUFBVSxDQUFDO0lBQ2hGLENBQUMsTUFBTSxDQUFDLGlDQUFpQyxDQUFDLEVBQUUsU0FBUztDQUN0RCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgbWF4LWxlbiAqL1xuLyogZXNsaW50LWRpc2FibGUgbm8tY29uc29sZSAqL1xuaW1wb3J0ICogYXMgY2ZuUmVzcG9uc2UgZnJvbSAnLi9jZm4tcmVzcG9uc2UnO1xuaW1wb3J0ICogYXMgY29uc3RzIGZyb20gJy4vY29uc3RzJztcbmltcG9ydCB7IGludm9rZUZ1bmN0aW9uLCBzdGFydEV4ZWN1dGlvbiB9IGZyb20gJy4vb3V0Ym91bmQnO1xuaW1wb3J0IHsgZ2V0RW52LCBsb2csIHBhcnNlSnNvblBheWxvYWQgfSBmcm9tICcuL3V0aWwnO1xuaW1wb3J0IHsgSXNDb21wbGV0ZVJlc3BvbnNlLCBPbkV2ZW50UmVzcG9uc2UgfSBmcm9tICcuLi90eXBlcyc7XG5cbi8vIHVzZSBjb25zdHMgZm9yIGhhbmRsZXIgbmFtZXMgdG8gY29tcGlsZXItZW5mb3JjZSB0aGUgY291cGxpbmcgd2l0aCBjb25zdHJ1Y3Rpb24gY29kZS5cbmV4cG9ydCA9IHtcbiAgW2NvbnN0cy5GUkFNRVdPUktfT05fRVZFTlRfSEFORExFUl9OQU1FXTogY2ZuUmVzcG9uc2Uuc2FmZUhhbmRsZXIob25FdmVudCksXG4gIFtjb25zdHMuRlJBTUVXT1JLX0lTX0NPTVBMRVRFX0hBTkRMRVJfTkFNRV06IGNmblJlc3BvbnNlLnNhZmVIYW5kbGVyKGlzQ29tcGxldGUpLFxuICBbY29uc3RzLkZSQU1FV09SS19PTl9USU1FT1VUX0hBTkRMRVJfTkFNRV06IG9uVGltZW91dCxcbn07XG5cbi8qKlxuICogVGhlIG1haW4gcnVudGltZSBlbnRyeXBvaW50IG9mIHRoZSBhc3luYyBjdXN0b20gcmVzb3VyY2UgbGFtYmRhIGZ1bmN0aW9uLlxuICpcbiAqIEFueSBsaWZlY3ljbGUgZXZlbnQgY2hhbmdlcyB0byB0aGUgY3VzdG9tIHJlc291cmNlcyB3aWxsIGludm9rZSB0aGlzIGhhbmRsZXIsIHdoaWNoIHdpbGwsIGluIHR1cm4sXG4gKiBpbnRlcmFjdCB3aXRoIHRoZSB1c2VyLWRlZmluZWQgYG9uRXZlbnRgIGFuZCBgaXNDb21wbGV0ZWAgaGFuZGxlcnMuXG4gKlxuICogVGhpcyBmdW5jdGlvbiB3aWxsIGFsd2F5cyBzdWNjZWVkLiBJZiBhbiBlcnJvciBvY2N1cnMsIGl0IGlzIGxvZ2dlZCBidXQgYW4gZXJyb3IgaXMgbm90IHRocm93bi5cbiAqXG4gKiBAcGFyYW0gY2ZuUmVxdWVzdCBUaGUgY2xvdWRmb3JtYXRpb24gY3VzdG9tIHJlc291cmNlIGV2ZW50LlxuICovXG5hc3luYyBmdW5jdGlvbiBvbkV2ZW50KGNmblJlcXVlc3Q6IEFXU0xhbWJkYS5DbG91ZEZvcm1hdGlvbkN1c3RvbVJlc291cmNlRXZlbnQpIHtcbiAgY29uc3Qgc2FuaXRpemVkUmVxdWVzdCA9IHsgLi4uY2ZuUmVxdWVzdCwgUmVzcG9uc2VVUkw6ICcuLi4nIH0gYXMgY29uc3Q7XG4gIGxvZygnb25FdmVudEhhbmRsZXInLCBzYW5pdGl6ZWRSZXF1ZXN0KTtcblxuICBjZm5SZXF1ZXN0LlJlc291cmNlUHJvcGVydGllcyA9IGNmblJlcXVlc3QuUmVzb3VyY2VQcm9wZXJ0aWVzIHx8IHsgfTtcblxuICBjb25zdCBvbkV2ZW50UmVzdWx0ID0gYXdhaXQgaW52b2tlVXNlckZ1bmN0aW9uKGNvbnN0cy5VU0VSX09OX0VWRU5UX0ZVTkNUSU9OX0FSTl9FTlYsIHNhbml0aXplZFJlcXVlc3QsIGNmblJlcXVlc3QuUmVzcG9uc2VVUkwpIGFzIE9uRXZlbnRSZXNwb25zZTtcbiAgaWYgKG9uRXZlbnRSZXN1bHQ/Lk5vRWNobykge1xuICAgIGxvZygncmVkYWN0ZWQgb25FdmVudCByZXR1cm5lZDonLCBjZm5SZXNwb25zZS5yZWRhY3REYXRhRnJvbVBheWxvYWQob25FdmVudFJlc3VsdCkpO1xuICB9IGVsc2Uge1xuICAgIGxvZygnb25FdmVudCByZXR1cm5lZDonLCBvbkV2ZW50UmVzdWx0KTtcbiAgfVxuXG4gIC8vIG1lcmdlIHRoZSByZXF1ZXN0IGFuZCB0aGUgcmVzdWx0IGZyb20gb25FdmVudCB0byBmb3JtIHRoZSBjb21wbGV0ZSByZXNvdXJjZSBldmVudFxuICAvLyB0aGlzIGFsc28gcGVyZm9ybXMgdmFsaWRhdGlvbi5cbiAgY29uc3QgcmVzb3VyY2VFdmVudCA9IGNyZWF0ZVJlc3BvbnNlRXZlbnQoY2ZuUmVxdWVzdCwgb25FdmVudFJlc3VsdCk7XG4gIGNvbnN0IHNhbml0aXplZEV2ZW50ID0geyAuLi5yZXNvdXJjZUV2ZW50LCBSZXNwb25zZVVSTDogJy4uLicgfTtcbiAgaWYgKG9uRXZlbnRSZXN1bHQ/Lk5vRWNobykge1xuICAgIGxvZygncmVhZGFjdGVkIGV2ZW50OicsIGNmblJlc3BvbnNlLnJlZGFjdERhdGFGcm9tUGF5bG9hZChzYW5pdGl6ZWRFdmVudCkpO1xuICB9IGVsc2Uge1xuICAgIGxvZygnZXZlbnQ6Jywgc2FuaXRpemVkRXZlbnQpO1xuICB9XG5cbiAgLy8gZGV0ZXJtaW5lIGlmIHRoaXMgaXMgYW4gYXN5bmMgcHJvdmlkZXIgYmFzZWQgb24gd2hldGhlciB3ZSBoYXZlIGFuIGlzQ29tcGxldGUgaGFuZGxlciBkZWZpbmVkLlxuICAvLyBpZiBpdCBpcyBub3QgZGVmaW5lZCwgdGhlbiB3ZSBhcmUgYmFzaWNhbGx5IHJlYWR5IHRvIHJldHVybiBhIHBvc2l0aXZlIHJlc3BvbnNlLlxuICBpZiAoIXByb2Nlc3MuZW52W2NvbnN0cy5VU0VSX0lTX0NPTVBMRVRFX0ZVTkNUSU9OX0FSTl9FTlZdKSB7XG4gICAgcmV0dXJuIGNmblJlc3BvbnNlLnN1Ym1pdFJlc3BvbnNlKCdTVUNDRVNTJywgcmVzb3VyY2VFdmVudCwgeyBub0VjaG86IHJlc291cmNlRXZlbnQuTm9FY2hvIH0pO1xuICB9XG5cbiAgLy8gb2ssIHdlIGFyZSBub3QgY29tcGxldGUsIHNvIGtpY2sgb2ZmIHRoZSB3YWl0ZXIgd29ya2Zsb3dcbiAgY29uc3Qgd2FpdGVyID0ge1xuICAgIHN0YXRlTWFjaGluZUFybjogZ2V0RW52KGNvbnN0cy5XQUlURVJfU1RBVEVfTUFDSElORV9BUk5fRU5WKSxcbiAgICBuYW1lOiByZXNvdXJjZUV2ZW50LlJlcXVlc3RJZCxcbiAgICBpbnB1dDogSlNPTi5zdHJpbmdpZnkocmVzb3VyY2VFdmVudCksXG4gIH07XG5cbiAgbG9nKCdzdGFydGluZyB3YWl0ZXInLCB7XG4gICAgc3RhdGVNYWNoaW5lQXJuOiBnZXRFbnYoY29uc3RzLldBSVRFUl9TVEFURV9NQUNISU5FX0FSTl9FTlYpLFxuICAgIG5hbWU6IHJlc291cmNlRXZlbnQuUmVxdWVzdElkLFxuICB9KTtcblxuICAvLyBraWNrIG9mZiB3YWl0ZXIgc3RhdGUgbWFjaGluZVxuICBhd2FpdCBzdGFydEV4ZWN1dGlvbih3YWl0ZXIpO1xufVxuXG4vLyBpbnZva2VkIGEgZmV3IHRpbWVzIHVudGlsIGBjb21wbGV0ZWAgaXMgdHJ1ZSBvciB1bnRpbCBpdCB0aW1lcyBvdXQuXG5hc3luYyBmdW5jdGlvbiBpc0NvbXBsZXRlKGV2ZW50OiBBV1NDREtBc3luY0N1c3RvbVJlc291cmNlLklzQ29tcGxldGVSZXF1ZXN0KSB7XG4gIGNvbnN0IHNhbml0aXplZFJlcXVlc3QgPSB7IC4uLmV2ZW50LCBSZXNwb25zZVVSTDogJy4uLicgfSBhcyBjb25zdDtcbiAgaWYgKGV2ZW50Py5Ob0VjaG8pIHtcbiAgICBsb2coJ3JlZGFjdGVkIGlzQ29tcGxldGUgcmVxdWVzdCcsIGNmblJlc3BvbnNlLnJlZGFjdERhdGFGcm9tUGF5bG9hZChzYW5pdGl6ZWRSZXF1ZXN0KSk7XG4gIH0gZWxzZSB7XG4gICAgbG9nKCdpc0NvbXBsZXRlJywgc2FuaXRpemVkUmVxdWVzdCk7XG4gIH1cblxuICBjb25zdCBpc0NvbXBsZXRlUmVzdWx0ID0gYXdhaXQgaW52b2tlVXNlckZ1bmN0aW9uKGNvbnN0cy5VU0VSX0lTX0NPTVBMRVRFX0ZVTkNUSU9OX0FSTl9FTlYsIHNhbml0aXplZFJlcXVlc3QsIGV2ZW50LlJlc3BvbnNlVVJMKSBhcyBJc0NvbXBsZXRlUmVzcG9uc2U7XG4gIGlmIChldmVudD8uTm9FY2hvKSB7XG4gICAgbG9nKCdyZWRhY3RlZCB1c2VyIGlzQ29tcGxldGUgcmV0dXJuZWQ6JywgY2ZuUmVzcG9uc2UucmVkYWN0RGF0YUZyb21QYXlsb2FkKGlzQ29tcGxldGVSZXN1bHQpKTtcbiAgfSBlbHNlIHtcbiAgICBsb2coJ3VzZXIgaXNDb21wbGV0ZSByZXR1cm5lZDonLCBpc0NvbXBsZXRlUmVzdWx0KTtcbiAgfVxuXG4gIC8vIGlmIHdlIGFyZSBub3QgY29tcGxldGUsIHJldHVybiBmYWxzZSwgYW5kIGRvbid0IHNlbmQgYSByZXNwb25zZSBiYWNrLlxuICBpZiAoIWlzQ29tcGxldGVSZXN1bHQuSXNDb21wbGV0ZSkge1xuICAgIGlmIChpc0NvbXBsZXRlUmVzdWx0LkRhdGEgJiYgT2JqZWN0LmtleXMoaXNDb21wbGV0ZVJlc3VsdC5EYXRhKS5sZW5ndGggPiAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wiRGF0YVwiIGlzIG5vdCBhbGxvd2VkIGlmIFwiSXNDb21wbGV0ZVwiIGlzIFwiRmFsc2VcIicpO1xuICAgIH1cblxuICAgIC8vIFRoaXMgbXVzdCBiZSB0aGUgZnVsbCBldmVudCwgaXQgd2lsbCBiZSBkZXNlcmlhbGl6ZWQgaW4gYG9uVGltZW91dGAgdG8gc2VuZCB0aGUgcmVzcG9uc2UgdG8gQ2xvdWRGb3JtYXRpb25cbiAgICB0aHJvdyBuZXcgY2ZuUmVzcG9uc2UuUmV0cnkoSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3BvbnNlID0ge1xuICAgIC4uLmV2ZW50LFxuICAgIC4uLmlzQ29tcGxldGVSZXN1bHQsXG4gICAgRGF0YToge1xuICAgICAgLi4uZXZlbnQuRGF0YSxcbiAgICAgIC4uLmlzQ29tcGxldGVSZXN1bHQuRGF0YSxcbiAgICB9LFxuICB9O1xuXG4gIGF3YWl0IGNmblJlc3BvbnNlLnN1Ym1pdFJlc3BvbnNlKCdTVUNDRVNTJywgcmVzcG9uc2UsIHsgbm9FY2hvOiBldmVudC5Ob0VjaG8gfSk7XG59XG5cbi8vIGludm9rZWQgd2hlbiBjb21wbGV0aW9uIHJldHJpZXMgYXJlIGV4aGF1c2VkLlxuYXN5bmMgZnVuY3Rpb24gb25UaW1lb3V0KHRpbWVvdXRFdmVudDogYW55KSB7XG4gIGxvZygndGltZW91dEhhbmRsZXInLCB0aW1lb3V0RXZlbnQpO1xuXG4gIGNvbnN0IGlzQ29tcGxldGVSZXF1ZXN0ID0gSlNPTi5wYXJzZShKU09OLnBhcnNlKHRpbWVvdXRFdmVudC5DYXVzZSkuZXJyb3JNZXNzYWdlKSBhcyBBV1NDREtBc3luY0N1c3RvbVJlc291cmNlLklzQ29tcGxldGVSZXF1ZXN0O1xuICBhd2FpdCBjZm5SZXNwb25zZS5zdWJtaXRSZXNwb25zZSgnRkFJTEVEJywgaXNDb21wbGV0ZVJlcXVlc3QsIHtcbiAgICByZWFzb246ICdPcGVyYXRpb24gdGltZWQgb3V0JyxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGludm9rZVVzZXJGdW5jdGlvbjxBIGV4dGVuZHMgeyBSZXNwb25zZVVSTDogJy4uLicgfT4oZnVuY3Rpb25Bcm5FbnY6IHN0cmluZywgc2FuaXRpemVkUGF5bG9hZDogQSwgcmVzcG9uc2VVcmw6IHN0cmluZykge1xuICBjb25zdCBmdW5jdGlvbkFybiA9IGdldEVudihmdW5jdGlvbkFybkVudik7XG4gIGxvZyhgZXhlY3V0aW5nIHVzZXIgZnVuY3Rpb24gJHtmdW5jdGlvbkFybn0gd2l0aCBwYXlsb2FkYCwgc2FuaXRpemVkUGF5bG9hZCk7XG5cbiAgLy8gdHJhbnNpZW50IGVycm9ycyBzdWNoIGFzIHRpbWVvdXRzLCB0aHJvdHRsaW5nIGVycm9ycyAoNDI5KSwgYW5kIG90aGVyXG4gIC8vIGVycm9ycyB0aGF0IGFyZW4ndCBjYXVzZWQgYnkgYSBiYWQgcmVxdWVzdCAoNTAwIHNlcmllcykgYXJlIHJldHJpZWRcbiAgLy8gYXV0b21hdGljYWxseSBieSB0aGUgSmF2YVNjcmlwdCBTREsuXG4gIGNvbnN0IHJlc3AgPSBhd2FpdCBpbnZva2VGdW5jdGlvbih7XG4gICAgRnVuY3Rpb25OYW1lOiBmdW5jdGlvbkFybixcblxuICAgIC8vIENhbm5vdCBzdHJpcCAnUmVzcG9uc2VVUkwnIGhlcmUgYXMgdGhpcyB3b3VsZCBiZSBhIGJyZWFraW5nIGNoYW5nZSBldmVuIHRob3VnaCB0aGUgZG93bnN0cmVhbSBDUiBkb2Vzbid0IG5lZWQgaXRcbiAgICBQYXlsb2FkOiBKU09OLnN0cmluZ2lmeSh7IC4uLnNhbml0aXplZFBheWxvYWQsIFJlc3BvbnNlVVJMOiByZXNwb25zZVVybCB9KSxcbiAgfSk7XG5cbiAgbG9nKCd1c2VyIGZ1bmN0aW9uIHJlc3BvbnNlOicsIHJlc3AsIHR5cGVvZihyZXNwKSk7XG5cbiAgLy8gUGFyc2VKc29uUGF5bG9hZCBpcyB2ZXJ5IGRlZmVuc2l2ZS4gSXQgc2hvdWxkIG5vdCBiZSBwb3NzaWJsZSBmb3IgYFBheWxvYWRgXG4gIC8vIHRvIGJlIGFueXRoaW5nIG90aGVyIHRoYW4gYSBKU09OIGVuY29kZWQgc3RyaW5nIChvciBpbnRhcnJheSkuIFNvbWV0aGluZyB3ZWlyZCBpc1xuICAvLyBnb2luZyBvbiBpZiB0aGF0IGhhcHBlbnMuIFN0aWxsLCB3ZSBzaG91bGQgZG8gb3VyIGJlc3QgdG8gc3Vydml2ZSBpdC5cbiAgY29uc3QganNvblBheWxvYWQgPSBwYXJzZUpzb25QYXlsb2FkKHJlc3AuUGF5bG9hZCk7XG4gIGlmIChyZXNwLkZ1bmN0aW9uRXJyb3IpIHtcbiAgICBsb2coJ3VzZXIgZnVuY3Rpb24gdGhyZXcgYW4gZXJyb3I6JywgcmVzcC5GdW5jdGlvbkVycm9yKTtcblxuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGpzb25QYXlsb2FkLmVycm9yTWVzc2FnZSB8fCAnZXJyb3InO1xuXG4gICAgLy8gcGFyc2UgZnVuY3Rpb24gbmFtZSBmcm9tIGFyblxuICAgIC8vIGFybjoke1BhcnRpdGlvbn06bGFtYmRhOiR7UmVnaW9ufToke0FjY291bnR9OmZ1bmN0aW9uOiR7RnVuY3Rpb25OYW1lfVxuICAgIGNvbnN0IGFybiA9IGZ1bmN0aW9uQXJuLnNwbGl0KCc6Jyk7XG4gICAgY29uc3QgZnVuY3Rpb25OYW1lID0gYXJuW2Fybi5sZW5ndGggLSAxXTtcblxuICAgIC8vIGFwcGVuZCBhIHJlZmVyZW5jZSB0byB0aGUgbG9nIGdyb3VwLlxuICAgIGNvbnN0IG1lc3NhZ2UgPSBbXG4gICAgICBlcnJvck1lc3NhZ2UsXG4gICAgICAnJyxcbiAgICAgIGBMb2dzOiAvYXdzL2xhbWJkYS8ke2Z1bmN0aW9uTmFtZX1gLCAvLyBjbG91ZHdhdGNoIGxvZyBncm91cFxuICAgICAgJycsXG4gICAgXS5qb2luKCdcXG4nKTtcblxuICAgIGNvbnN0IGUgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG5cbiAgICAvLyB0aGUgb3V0cHV0IHRoYXQgZ29lcyB0byBDRk4gaXMgd2hhdCdzIGluIGBzdGFja2AsIG5vdCB0aGUgZXJyb3IgbWVzc2FnZS5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgcmVtb3RlIHRyYWNlLCBjb25zdHJ1Y3QgYSBuaWNlIG1lc3NhZ2Ugd2l0aCBsb2cgZ3JvdXAgaW5mb3JtYXRpb25cbiAgICBpZiAoanNvblBheWxvYWQudHJhY2UpIHtcbiAgICAgIC8vIHNraXAgZmlyc3QgdHJhY2UgbGluZSBiZWNhdXNlIGl0J3MgdGhlIG1lc3NhZ2VcbiAgICAgIGUuc3RhY2sgPSBbbWVzc2FnZSwgLi4uanNvblBheWxvYWQudHJhY2Uuc2xpY2UoMSldLmpvaW4oJ1xcbicpO1xuICAgIH1cblxuICAgIHRocm93IGU7XG4gIH1cblxuICByZXR1cm4ganNvblBheWxvYWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlc3BvbnNlRXZlbnQoY2ZuUmVxdWVzdDogQVdTTGFtYmRhLkNsb3VkRm9ybWF0aW9uQ3VzdG9tUmVzb3VyY2VFdmVudCwgb25FdmVudFJlc3VsdDogT25FdmVudFJlc3BvbnNlKTogQVdTQ0RLQXN5bmNDdXN0b21SZXNvdXJjZS5Jc0NvbXBsZXRlUmVxdWVzdCB7XG4gIC8vXG4gIC8vIHZhbGlkYXRlIHRoYXQgb25FdmVudFJlc3VsdCBhbHdheXMgaW5jbHVkZXMgYSBQaHlzaWNhbFJlc291cmNlSWRcblxuICBvbkV2ZW50UmVzdWx0ID0gb25FdmVudFJlc3VsdCB8fCB7IH07XG5cbiAgLy8gaWYgcGh5c2ljYWwgSUQgaXMgbm90IHJldHVybmVkLCB3ZSBoYXZlIHNvbWUgZGVmYXVsdHMgZm9yIHlvdSBiYXNlZFxuICAvLyBvbiB0aGUgcmVxdWVzdCB0eXBlLlxuICBjb25zdCBwaHlzaWNhbFJlc291cmNlSWQgPSBvbkV2ZW50UmVzdWx0LlBoeXNpY2FsUmVzb3VyY2VJZCB8fCBkZWZhdWx0UGh5c2ljYWxSZXNvdXJjZUlkKGNmblJlcXVlc3QpO1xuXG4gIC8vIGlmIHdlIGFyZSBpbiBERUxFVEUgYW5kIHBoeXNpY2FsIElEIHdhcyBjaGFuZ2VkLCBpdCdzIGFuIGVycm9yLlxuICBpZiAoY2ZuUmVxdWVzdC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScgJiYgcGh5c2ljYWxSZXNvdXJjZUlkICE9PSBjZm5SZXF1ZXN0LlBoeXNpY2FsUmVzb3VyY2VJZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgREVMRVRFOiBjYW5ub3QgY2hhbmdlIHRoZSBwaHlzaWNhbCByZXNvdXJjZSBJRCBmcm9tIFwiJHtjZm5SZXF1ZXN0LlBoeXNpY2FsUmVzb3VyY2VJZH1cIiB0byBcIiR7b25FdmVudFJlc3VsdC5QaHlzaWNhbFJlc291cmNlSWR9XCIgZHVyaW5nIGRlbGV0aW9uYCk7XG4gIH1cblxuICAvLyBpZiB3ZSBhcmUgaW4gVVBEQVRFIGFuZCBwaHlzaWNhbCBJRCB3YXMgY2hhbmdlZCwgaXQncyBhIHJlcGxhY2VtZW50IChqdXN0IGxvZylcbiAgaWYgKGNmblJlcXVlc3QuUmVxdWVzdFR5cGUgPT09ICdVcGRhdGUnICYmIHBoeXNpY2FsUmVzb3VyY2VJZCAhPT0gY2ZuUmVxdWVzdC5QaHlzaWNhbFJlc291cmNlSWQpIHtcbiAgICBsb2coYFVQREFURTogY2hhbmdpbmcgcGh5c2ljYWwgcmVzb3VyY2UgSUQgZnJvbSBcIiR7Y2ZuUmVxdWVzdC5QaHlzaWNhbFJlc291cmNlSWR9XCIgdG8gXCIke29uRXZlbnRSZXN1bHQuUGh5c2ljYWxSZXNvdXJjZUlkfVwiYCk7XG4gIH1cblxuICAvLyBtZXJnZSByZXF1ZXN0IGV2ZW50IGFuZCByZXN1bHQgZXZlbnQgKHJlc3VsdCBwcmV2YWlscykuXG4gIHJldHVybiB7XG4gICAgLi4uY2ZuUmVxdWVzdCxcbiAgICAuLi5vbkV2ZW50UmVzdWx0LFxuICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogcGh5c2ljYWxSZXNvdXJjZUlkLFxuICB9O1xufVxuXG4vKipcbiAqIENhbGN1bGF0ZXMgdGhlIGRlZmF1bHQgcGh5c2ljYWwgcmVzb3VyY2UgSUQgYmFzZWQgaW4gY2FzZSB1c2VyIGhhbmRsZXIgZGlkXG4gKiBub3QgcmV0dXJuIGEgUGh5c2ljYWxSZXNvdXJjZUlkLlxuICpcbiAqIEZvciBcIkNSRUFURVwiLCBpdCB1c2VzIHRoZSBSZXF1ZXN0SWQuXG4gKiBGb3IgXCJVUERBVEVcIiBhbmQgXCJERUxFVEVcIiBhbmQgcmV0dXJucyB0aGUgY3VycmVudCBQaHlzaWNhbFJlc291cmNlSWQgKHRoZSBvbmUgcHJvdmlkZWQgaW4gYGV2ZW50YCkuXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRQaHlzaWNhbFJlc291cmNlSWQocmVxOiBBV1NMYW1iZGEuQ2xvdWRGb3JtYXRpb25DdXN0b21SZXNvdXJjZUV2ZW50KTogc3RyaW5nIHtcbiAgc3dpdGNoIChyZXEuUmVxdWVzdFR5cGUpIHtcbiAgICBjYXNlICdDcmVhdGUnOlxuICAgICAgcmV0dXJuIHJlcS5SZXF1ZXN0SWQ7XG5cbiAgICBjYXNlICdVcGRhdGUnOlxuICAgIGNhc2UgJ0RlbGV0ZSc6XG4gICAgICByZXR1cm4gcmVxLlBoeXNpY2FsUmVzb3VyY2VJZDtcblxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgXCJSZXF1ZXN0VHlwZVwiIGluIHJlcXVlc3QgXCIke0pTT04uc3RyaW5naWZ5KHJlcSl9XCJgKTtcbiAgfVxufVxuIl19