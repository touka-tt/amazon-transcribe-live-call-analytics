/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

// TODO: Add Metrics & Logger from Lambda Powertools
// TODO: Retries and resiliency
// TODO: Debug why sometimes it is now working twice

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} = require('@aws-sdk/client-transcribe-streaming');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const BlockStream = require('block-stream2');
const fs = require('fs');
const stream = require('stream');
const { PassThrough } = require('stream');
const interleave = require('interleave-stream');

const { EbmlStreamDecoder, EbmlTagId, EbmlTagPosition } = require('ebml-stream');
const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoMedia } = require('@aws-sdk/client-kinesis-video-media');

const mergeFiles = require('./mergeFiles');
const { KinesisClient, PutRecordCommand } = require('@aws-sdk/client-kinesis');
const { createHook } = require('async_hooks');

const REGION = process.env.REGION || 'us-east-1';
const { TRANSCRIBER_CALL_EVENT_TABLE_NAME } = process.env;
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/';
const RAW_FILE_PREFIX = process.env.RAW_FILE_PREFIX || 'lca-audio-raw/';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || '/tmp/';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128', 10);
const SAVE_PARTIAL_TRANSCRIPTS = (process.env.SAVE_PARTIAL_TRANSCRIPTS || 'true') === 'true';
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';
const KEEP_ALIVE = process.env.KEEP_ALIVE || '10000';
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME || '';
const KINESIS_STREAM_ARN = process.env.KINESIS_STREAM_ARN || '';
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;

const s3Client = new S3Client({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const kinesisClient = new KinesisClient({ region: REGION });

let timeToStop = false;
let stopTimer;
let keepAliveTimer;
let keepAliveChunk = Buffer.alloc(2, 0);

const getExpiration = function (numberOfDays) {
  return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const sleep = async function (msec) {
  return new Promise((resolve) => setTimeout(resolve, msec));
}

const writeS3Url = async function (callId) {
  console.log('Writing S3 URL To Dynamo');

  const now = new Date().toISOString();
  const eventType = 'ADD_S3_RECORDING_URL';
  const recordingUrl = `https://${OUTPUT_BUCKET}.s3.${REGION}.amazonaws.com/${RECORDING_FILE_PREFIX}${callId}.wav`;

  const putObj = {
    CallId: callId,
    RecordingUrl: recordingUrl,
    EventType: eventType.toString(),
    CreatedAt: now,
  };

  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing transcription segment', error);
  }
};

const writeToS3 = async function (sourceFile, destBucket, destPrefix, destKey) {
  console.log('Uploading to S3');

  let data;
  const fileStream = fs.createReadStream(sourceFile);
  const uploadParams = {
    Bucket: OUTPUT_BUCKET,
    Key: destPrefix + destKey,
    Body: fileStream,
  };
  try {
    data = await s3Client.send(new PutObjectCommand(uploadParams));
    console.log('Uploading to S3 complete: ', data);
  } catch (err) {
    console.error('S3 upload error: ', JSON.stringify(err));
  } finally {
    fileStream.destroy();
  }
  return data;
};

const deleteTempFile = async function (sourceFile) {
  try {
    console.log('deleting tmp file');
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    console.error('error deleting: ', err);
  }
};

const writeTranscriptionSegment = async function (
  transcriptionEvent,
  callId,
  streamArn,
  transactionId,
) {
  // only write if there is more than 0
  const result = transcriptionEvent.TranscriptEvent.Transcript.Results[0];
  if (!result) return;
  if (result.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS) {
    return;
  }
  const transcript = result.Alternatives[0];
  if (!transcript.Transcript) return;

  const channel = result.ChannelId === 'ch_0' ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();
  const eventType = 'ADD_TRANSCRIPT_SEGMENT';

  const putObj = {
    Channel: channel,
    StreamArn: streamArn,
    TransactionId: transactionId,
    CallId: callId,
    SegmentId: result.ResultId,
    StartTime: result.StartTime.toString(),
    EndTime: result.EndTime.toString(),
    Transcript: result.Alternatives[0].Transcript,
    IsPartial: result.IsPartial,
    EventType: eventType.toString(),
    CreatedAt: now,
  };

  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing transcription segment', error);
  }
};

const writeCallEventToKds = async function (callEvent) {
  const startTime = new Date(callEvent.detail.startTime);
  const eventType = EVENT_TYPE[callEvent.detail.streamingStatus];
  const channel = callEvent.detail.isCaller ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();

  const putObj = {
    CallId: callEvent.detail.callId,
    CreatedAt: now,
    CustomerPhoneNumber: callEvent.detail.fromNumber,
    SystemPhoneNumber: callEvent.detail.toNumber,
    AgentId: callEvent.detail.agentId,
    Channel: channel,
    EventType: eventType,
    StreamArn: callEvent.detail.streamArn,
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callEvent.detail.callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing transcription segment', error);
  }
};

const writeStatusToKds = async function (channel, status, callId, streamArn, transactionId) {
  const now = new Date().toISOString();
  const putObj = {
    CallId: callId,
    Channel: channel,
    StreamArn: streamArn,
    TransactionId: transactionId,
    EventType: status,
    CreatedAt: now,
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing transcription segment', error);
  }
};

const writeCallEventToDynamo = async function (callEvent) {
    const startTime = new Date(callEvent.detail.startTime);
    const expiration = getExpiration(1);
    const eventType = EVENT_TYPE[callEvent.detail.streamingStatus];
    const channel = callEvent.detail.isCaller ? 'CALLER' : 'AGENT';
    const now = new Date().toISOString();

    const putParams = {
      TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
      Item: {
        PK: { S: `ce#${callEvent.detail.callId}` },
        SK: { S: `${channel}` },
        CallId: { S: callEvent.detail.callId },
        ExpiresAfter: { N: expiration.toString() },
        CreatedAt: { S: now },
        CustomerPhoneNumber: { S: callEvent.detail.fromNumber },
        SystemPhoneNumber: { S: callEvent.detail.toNumber },
        Channel: { S: channel },
        EventType: { S: eventType },
        StreamArn: { S: callEvent.detail.streamArn },
      },
    };
    console.log(putParams);
    const putCmd = new PutItemCommand(putParams);
    try {
      await dynamoClient.send(putCmd);
    } catch (error) {
      console.error('Error writing event', error);
    }
};

const writeCallMetaDataToDynamo = async function (callMetadata) {
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `cd#${callMetadata.callId}` },
      SK: { S: `BOTH` },
      CallId: { S: callEvent.detail.callId },
      ExpiresAfter: { N: expiration.toString() },
      CreatedAt: { S: now },
      CustomerPhoneNumber: { S: callEvent.detail.fromNumber },
      SystemPhoneNumber: { S: callEvent.detail.toNumber },
      Channel: { S: channel },
      EventType: { S: eventType },
      StreamArn: { S: callEvent.detail.streamArn },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing event', error);
  }
};

// Retrieve Chime stream event for specified channel, waiting for up to 10s
const getChannelStreamFromDynamo = async function (callId, channel) {
  // Set the parameters
  const params = {
    Key: {
      "PK": {
        S: `ce#${callId}`
      },
      "SK": {
        S: `${channel}`
      }
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log("GetItem params: ", JSON.stringify(params));
  const command = new GetItemCommand(params);
  let agentStreamArn = undefined;
  let loopCount = 0;
  while (agentStreamArn === undefined && loopCount++ < 100) {
    const data = await dynamoClient.send(command);
    console.log("GetItem result: ",JSON.stringify(data));
    if (data.Item) {
      if (data.Item.StreamArn) agentStreamArn = data.Item.StreamArn.S;
    } else {
      console.log(loopCount, `${channel} stream not yet available. Sleeping 100ms.`);
      await sleep(100);
    }
  }
  return agentStreamArn;
};


const readKVS = async (streamName, streamArn, lastFragment, streamPipe) => {
  let actuallyStop = false;
  let firstDecodeEbml = true;

  let lastMessageTime;

  console.log('inside readKVS worker', REGION, streamName, streamArn);
  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.SimpleTag, EbmlTagId.SimpleBlock],
  });
  decoder.on('error', (error) => {
    console.log('Decoder Error:', JSON.stringify(error));
  });
  decoder.on('data', (chunk) => {
    lastMessageTime = Date().now;
    if (chunk.id === EbmlTagId.Segment && chunk.position === EbmlTagPosition.End) {
      // this is the end of a segment. Lets forcefully stop if needed.
      if (timeToStop) actuallyStop = true;
    }
    if (!timeToStop) {
      if (chunk.id === EbmlTagId.SimpleTag) {
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_FRAGMENT_NUMBER') {
          lastFragment = chunk.Children[1].data;
        }
      }
      if (chunk.id === EbmlTagId.SimpleBlock) {
        if (firstDecodeEbml) {
          firstDecodeEbml = false;
          console.log(`decoded ebml, simpleblock size:${chunk.size} stream: ${streamName}`);
        }
        try {
          streamPipe.write(chunk.payload);
        } catch (error) {
          console.error('Error posting payload chunk', error);
        }
      }
    }
  }); // use this to find last fragment tag we received
  decoder.on('end', () => {
    // close stdio
    console.log(streamName, 'Finished');
    console.log(`Last fragment for ${streamName} ${lastFragment} total size: ${totalSize}`);
  });
  console.log(`Starting stream ${streamName}`);
  const kvClient = new KinesisVideoClient({ REGION });
  const getDataCmd = new GetDataEndpointCommand({ APIName: 'GET_MEDIA', StreamARN: streamArn });
  const response = await kvClient.send(getDataCmd);
  const mediaClient = new KinesisVideoMedia({ REGION, endpoint: response.DataEndpoint });
  let fragmentSelector = { StreamARN: streamArn, StartSelector: { StartSelectorType: 'NOW' } };
  if (lastFragment && lastFragment.length > 0) {
    fragmentSelector = {
      StreamARN: streamArn,
      StartSelector: {
        StartSelectorType: 'FRAGMENT_NUMBER',
        AfterFragmentNumber: lastFragment,
      },
    };
  }
  const result = await mediaClient.getMedia(fragmentSelector);
  const streamReader = result.Payload;

  const timeout = setTimeout(() => {
    // Check every 10 seconds if 5 minutes have passed
    if (Date.now() - lastMessageTime > 1000 * 60 * 5) {
      clearInterval(timeout);
      streamReader.destroy();
    }
  }, 10000);

  let totalSize = 0;
  let firstKvsChunk = true;
  try {
    for await (const chunk of streamReader) {
      if (firstKvsChunk) {
        firstKvsChunk = false;
        console.log(`${streamName} received chunk size: ${chunk.length}`);
      }
      totalSize += chunk.length;
      decoder.write(chunk);
      if (actuallyStop) break;
    }
  } catch (error) {
    console.error('error writing to decoder', error);
  } finally {
    console.log(`Closing buffers ${streamName}`);
    decoder.end();
  }

  return lastFragment;
};


const readTranscripts = async function (tsStream, callId, callerStreamArn, sessionId) {
  try {
    for await (const chunk of tsStream) {
      writeTranscriptionSegment(chunk, callId, callerStreamArn, sessionId);
    }
  } catch (error) {
    console.error('error writing transcription segment', JSON.stringify(error));
    writeStatusToKds('STEREO', 'TRANSCRIPT_ERROR', callId, callerStreamArn, sessionId);
  } finally {
    // writeStatusToKds('STEREO', 'END_TRANSCRIPT', callId, callerStreamArn, sessionId);
  }
};

const go = async function (
  callId,
  lambdaCount,
  agentStreamArn,
  callerStreamArn,
  sessionId,
  lastAgentFragment,
  lastCallerFragment,
) {
  let firstChunkToTranscribe = true;
  const passthroughStream = new stream.PassThrough({ highWaterMark: BUFFER_SIZE });
  const audioStream = async function* () {
    try {
      for await (const payloadChunk of passthroughStream) {
        if (firstChunkToTranscribe) {
          firstChunkToTranscribe = false;
          console.log('Sending first chunk to transcribe: ', payloadChunk.length);
        }
        yield { AudioEvent: { AudioChunk: payloadChunk } };
      }
    } catch (error) {
      console.log('Error reading passthrough stream or yielding audio chunk.');
    }
  };

  const tempRecordingFilename = `${callId}-${lambdaCount}.raw`;
  const writeRecordingStream = fs.createWriteStream(TEMP_FILE_PATH + tempRecordingFilename);

  const tsClient = new TranscribeStreamingClient({ region: REGION });
  const tsParams = {
    LanguageCode: TRANSCRIBE_LANGUAGE_CODE,
    MediaEncoding: 'pcm',
    MediaSampleRateHertz: 8000,
    NumberOfChannels: 2,
    EnableChannelIdentification: true,
    AudioStream: audioStream(),
  };

  if (sessionId !== undefined) {
    tsParams.SessionId = sessionId;
  }

  if (IS_CONTENT_REDACTION_ENABLED && TRANSCRIBE_LANGUAGE_CODE === 'en-US') {
    tsParams.ContentRedactionType = CONTENT_REDACTION_TYPE;
    if (PII_ENTITY_TYPES) tsParams.PiiEntityTypes = PII_ENTITY_TYPES;
  }

  if (CUSTOM_VOCABULARY_NAME) {
    tsParams.VocabularyName = CUSTOM_VOCABULARY_NAME;
  }

  const tsCmd = new StartStreamTranscriptionCommand(tsParams);
  const tsResponse = await tsClient.send(tsCmd);
  // console.log(tsResponse);
  sessionId = tsResponse.SessionId;
  if (lastAgentFragment === undefined) {
    writeStatusToKds('STEREO', 'START_TRANSCRIPT', callId, callerStreamArn, sessionId);
  }
  else writeStatusToKds('STEREO', 'CONTINUE_TRANSCRIPT', callId, callerStreamArn, sessionId);
  console.log('creating readable from transcript stream');
  const tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);

  console.log('creating interleave streams');
  const agentBlock = new BlockStream(2);
  const callerBlock = new BlockStream(2);
  const combinedStream = new PassThrough();
  const combinedStreamBlock = new BlockStream(4);
  combinedStream.pipe(combinedStreamBlock);
  combinedStreamBlock.on('data', (chunk) => {
    passthroughStream.write(chunk);
    writeRecordingStream.write(chunk);
  });

  interleave([agentBlock, callerBlock]).pipe(combinedStream);
  console.log('starting workers');

  const callerWorker = readKVS('Caller', callerStreamArn, lastCallerFragment, callerBlock);
  const agentWorker = readKVS('Agent', agentStreamArn, lastAgentFragment, agentBlock);

  console.log('done starting workers');

  timeToStop = false;
  stopTimer = setTimeout(() => {
    timeToStop = true;
  }, TIMEOUT);

  keepAliveTimer = setInterval(() => {
    if (timeToStop === true) {
      clearInterval(keepAliveTimer);
    } else {
      agentBlock.write(keepAliveChunk);
      callerBlock.write(keepAliveChunk);
    }
  }, KEEP_ALIVE);

  const transcribePromise = readTranscripts(tsStream, callId, callerStreamArn, sessionId);

  const returnVals = await Promise.all([callerWorker, agentWorker]);

  // we are done with transcribe.
  passthroughStream.end();

  await transcribePromise;

  console.log('Done with all 3 streams');
  console.log('Last Caller Fragment: ', returnVals[0]);
  console.log('Last Agent Fragment: ', returnVals[1]);

  // stop the timer so when we finish and upload to s3 this doesnt kick in
  if (timeToStop === false) {
    clearTimeout(stopTimer);
    timeToStop = false;
  }

  writeRecordingStream.end();

  return {
    agentStreamArn,
    callerStreamArn,
    lastCallerFragment: returnVals[0],
    lastAgentFragment: returnVals[1],
    sessionId,
    tempFileName: tempRecordingFilename,
  };
};

// async function handler (event) {
const handler = async function (event, context) {

  if (!event.detail.lambdaCount) event.detail.lambdaCount = 0;
  if (event.detail.lambdaCount > 30) {
    console.log('Stopping due to runaway recursive Lambda.');
  }

  console.log(JSON.stringify(event));

  let result;

  if (event.detail.streamingStatus === 'CONTINUE') {
    console.log('---CONTINUING FROM PREVIOUS LAMBDA: ', event.detail.lambdaCount, '---');
    result = await go(
      event.detail.callId,
      event.detail.lambdaCount,
      event.detail.agentStreamArn,
      event.detail.callerStreamArn,
      event.detail.transcribeSessionId,
      event.detail.lastAgentFragment,
      event.detail.lastCallerFragment,
    );
  }

  if (event.source === "aws.chime" && event.detail.streamingStatus === 'STARTED') {

    console.log("AWS Chime stream STARTED event received. Save 'ce#' record to DynamoDB.");
    await writeCallEventToDynamo(event);

    if (event.detail.isCaller === false) {
      console.log("This is the AGENT stream (isCaller is false). Exit and wait for CALLER stream event to arrive.");
      return;
    }

    console.log("This is the CALLER stream (isCaller is true). Get AGENT stream data from DynamoDB.");
    let callerStreamArn = event.detail.streamArn;
    let agentStreamArn = await getChannelStreamFromDynamo(
      event.detail.callId,
      'AGENT',
    );
    if (agentStreamArn == undefined) {
      console.log(`Timed out waiting for AGENT stream event after 10s. Exiting.`);
      return;
    }

    // Call customer LambdaHook, if present
    if (LAMBDA_HOOK_FUNCTION_ARN) {
      // invoke lambda function
      // if it fails, just throw an exception and exit
      console.log(`Invoking LambdaHook: ${LAMBDA_HOOK_FUNCTION_ARN}`);
      const invokeCmd = new InvokeCommand({
        FunctionName: LAMBDA_HOOK_FUNCTION_ARN,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(event),
      });
      const lambdaResponse = await lambdaClient.send(invokeCmd);
      const payload = JSON.parse(Buffer.from(lambdaResponse.Payload));
      console.log(`LambdaHook response: ${JSON.stringify(payload)}`);
      if (lambdaResponse.FunctionError) {
        console.log('Lambda failed to run, throwing an exception');
        throw new Error(payload);
      }
      /* Process the response. Payload looks like this:
          {
            // all fields optional
            originalCallId: <string>,
            shouldProcessCall: <boolean>,
            isCaller: <boolean>,
            callId: <string>,
            agentId: <string>,
            fromNumber: <string>,
            toNumber: <string>
          }
      */

      // New CallId?
      if (payload.callId) {
        console.log(`Lambda hook returned new callId: "${payload.callId}"`);
        event.detail.callId = payload.callId;
      }

      // Swap caller and agent channels?
      if (payload.isCaller === false) {
        console.log(`Lambda hook returned isCaller=false, swapping caller/agent streams`);
        [agentStreamArn, callerStreamArn] = [callerStreamArn, agentStreamArn];
      }
      if (payload.isCaller === true) {
        console.log(`Lambda hook returned isCaller=true, caller/agent streams not swapped`);
      }

      // AgentId?
      if (payload.agentId) {
        console.log(`Lambda hook returned agentId: "${payload.agentId}"`);
        event.detail.agentId = payload.agentId;
      }

      // New 'to' or 'from' phone numbers?
      if (payload.fromNumber) {
        console.log(`Lambda hook returned fromNumber: "${payload.fromNumber}"`);
        event.detail.fromNumber = payload.fromNumber;
      }
      if (payload.toNumber) {
        console.log(`Lambda hook returned toNumber: "${payload.toNumber}"`);
        event.detail.toNumber = payload.toNumber;
      }

      // Should we process this call?
      if (payload.shouldProcessCall === false) {
        console.log('Lambda hook returned shouldProcessCall=false, exiting.');
        return;
      }
      if (payload.shouldProcessCall === true) {
        console.log('Lambda hook returned shouldProcessCall=true, continuing.');
      }

    }

    await writeCallEventToKds(event);

    result = await go(
      event.detail.callId,
      0,
      agentStreamArn,
      callerStreamArn,
      undefined,
      undefined,
      undefined,
    );
  }

  if (result) {
    if (timeToStop) {
      console.log('Starting new Lambda');
      event.detail.streamingStatus = 'CONTINUE';
      event.detail.agentStreamArn = result.agentStreamArn;
      event.detail.callerStreamArn = result.callerStreamArn;
      event.detail.lastAgentFragment = result.lastAgentFragment;
      event.detail.lastCallerFragment = result.lastCallerFragment;
      event.detail.transcribeSessionId = result.sessionId;
      if (!event.detail.lambdaCount) event.detail.lambdaCount = 1;
      else event.detail.lambdaCount = event.detail.lambdaCount + 1;

      // we need to launch a new one
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(event),
      });
      await lambdaClient.send(invokeCmd);
    } else {
      writeStatusToKds(
        'STEREO',
        'END_TRANSCRIPT',
        event.detail.callId,
        event.detail.streamArn,
        event.detail.transcribeSessionId ? event.detail.transcribeSessionId : '',
      );
    }

    // regardless, write to s3 before completely exiting
    await writeToS3(
      TEMP_FILE_PATH + result.tempFileName,
      OUTPUT_BUCKET,
      RAW_FILE_PREFIX,
      result.tempFileName,
    );
    await deleteTempFile(TEMP_FILE_PATH + result.tempFileName);

    if (!timeToStop) {
      await mergeFiles.mergeFiles({
        bucketName: OUTPUT_BUCKET,
        recordingPrefix: RECORDING_FILE_PREFIX,
        rawPrefix: RAW_FILE_PREFIX,
        callId: event.detail.callId,
        lambdaCount: event.detail.lambdaCount,
      });
      await writeS3Url(event.detail.callId);
    }
  }
  return 'not done yet';
};

exports.handler = handler;
