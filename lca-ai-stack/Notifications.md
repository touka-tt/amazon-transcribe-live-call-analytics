# Configure SNS Notifications on Call Categories

Call Analytics supports the creation of custom categories so you can tailor your transcript analysis to your specific business needs.

You can create as many categories as you'd like to cover a range of different scenarios. For each category you create, you must create between 1 and 20 rules. Each rule is based on one of four criteria: interruptions, keywords, non-talk time, or sentiment. For more details on using these criteria with the [CreateCallAnalyticsCategory](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_CreateCallAnalyticsCategory.html) operation, refer to the [Rule criteria](https://docs.aws.amazon.com/transcribe/latest/dg/call-analytics-create-categories.html#call-analytics-create-categories-rules#call-analytics-create-categories-rules) section.

When Live Call Analytics receives a category match event from Transcribe Call Analytics, LCA will publish a message to a pre-created [Amazon Simple Notification Service (Amazon SNS) topic](https://docs.aws.amazon.com/sns/latest/dg/welcome.html) that is created when LCA is deployed.

Amazon SNS is a managed service that provides message delivery from publishers (LCA) to subscribers (also known as producers and consumers). 

Additionally, LCA contains a CloudFormation parameter called `CategoryAlertRegEx` that allows you to define a Regular Expression that will distinguish whether a category match is an alert, or not an alert. 

The schema that is published by LCA to SNS is as follows:

```
{
  "call_id": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", 
  "category_name": "MatchedCategory", 
  "alert": true/false
}
```

You can configure SNS with [SNS Filters](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html) to only send messages to subscribers if `alert` is true.

SNS messages can be sent downstream to subscribers such as

- Application-to-application messaging destinations:
  - Amazon Kinesis Data Firehose
  - AWS Lambda
  - Amazon SQS
  - Amazon Event Fork Pipelines
  - HTTP/S endpoints
  
- Application-to-person notifications:
  - SMS
  - Email
  - Mobile Push Notifications
  - AWS Chatbot
  - PagerDuty
