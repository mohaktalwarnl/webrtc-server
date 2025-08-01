const amqp = require("amqplib");

exports.ChatHistoryConversionPushToQueue = async function (data) {
  const exchangeName = "proctoring_exchange";
  const queueName = "chat_history_queue";
  const routingKey = "CHAT";
  let localConnection;
  let localChannel;

  try {
    localConnection = await amqp.connect(process.env.RABBITMQ_URL);
    localChannel = await localConnection.createChannel();

    // 1. Assert exchange
    await localChannel.assertExchange(exchangeName, "direct", {
      durable: true,
    });

    // 2. Assert queue
    await localChannel.assertQueue(queueName, { durable: true });

    // 3. Bind queue to exchange with routing key
    await localChannel.bindQueue(queueName, exchangeName, routingKey);

    // 4. Publish message to exchange with routing key
    const messageBuffer = Buffer.from(JSON.stringify(data));
    const publishStatus = localChannel.publish(
      exchangeName,
      routingKey,
      messageBuffer,
      { persistent: true }
    );

    console.log(
      `[x] Sent to exchange "${exchangeName}" with routing key "${routingKey}":`,
      data
    );

    await localChannel.close();
    await localConnection.close();

    return {
      error: false,
      status: 200,
      message_code: "CHAT_HISTORY_SAVED_SUCCESSFULLY",
      data: publishStatus,
    };
  } catch (error) {
    if (localChannel) await localChannel.close().catch(() => {});
    if (localConnection) await localConnection.close().catch(() => {});
    console.error({
      error: true,
      message: error.message,
      details: error.stack,
      source: "services/pushToQueueService/ChatHistoryConversionPushToQueue",
    });
  }
};