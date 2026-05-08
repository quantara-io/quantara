import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

export async function publish(
  queueUrl: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        type,
        data: payload,
        timestamp: new Date().toISOString(),
      }),
    }),
  );
}
