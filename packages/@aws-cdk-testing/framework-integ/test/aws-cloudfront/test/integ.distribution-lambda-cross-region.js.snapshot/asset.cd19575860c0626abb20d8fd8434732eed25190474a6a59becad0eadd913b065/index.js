"use strict";var{SSM:a}=require("@aws-sdk/client-ssm");exports.handler=async function(n){let e=n.ResourceProperties;if(console.info(`Reading function ARN from SSM parameter ${e.ParameterName} in region ${e.Region}`),n.RequestType==="Create"||n.RequestType==="Update"){let r=await new a({region:e.Region}).getParameter({Name:e.ParameterName});return console.info("Response: %j",r),{Data:{FunctionArn:r.Parameter.Value}}}};
