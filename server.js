const express = require("express");
const https = require("https");
const socketIO = require("socket.io");
const fs = require("fs");
const mediasoup = require("mediasoup");

const app = express();

const options = {
	key: fs.readFileSync("/etc/ssl/private/164.52.215.33.key"),
	cert: fs.readFileSync("/etc/ssl/certs/164.52.215.33.crt"),
};

const server = https.createServer(options, app);
const io = socketIO(server, { cors: { origin: "*" } });

// ----------------- Mediasoup Setup -----------------

// Create a single Mediasoup Worker instance for the server.
// In production, consider clustering (using Node's cluster module) to take advantage of multiple cores.
let mediasoupWorker;
(async () => {
	try {
		mediasoupWorker = await mediasoup.createWorker({
			logLevel: "warn",
			rtcMinPort: 40000,
			rtcMaxPort: 49999,
		});
		mediasoupWorker.on("died", () => {
			console.error("Mediasoup Worker died, exiting process...");
			process.exit(1);
		});
	} catch (err) {
		console.error("Error creating Mediasoup Worker:", err);
	}
})();

// Store exam rooms. Each exam room (by examId) has its own Mediasoup router, transports, and producers.
const examRooms = {}; // { examId: { router, transports: { [clientId]: { send, recv } }, producers: { [clientId]: producer } } }

// Helper function: Get or create an exam room.
async function getOrCreateExamRoom(examId) {
	if (!examRooms[examId]) {
		const router = await mediasoupWorker.createRouter({
			mediaCodecs: [
				{
					kind: "audio",
					mimeType: "audio/opus",
					clockRate: 48000,
					channels: 2,
				},
				{
					kind: "video",
					mimeType: "video/VP8",
					clockRate: 90000,
					parameters: {},
				},
			],
		});
		examRooms[examId] = {
			router,
			transports: {}, // Store transports per clientId.
			producers: {}, // Store producers per clientId.
		};
	}
	return examRooms[examId];
}

// ----------------- Socket.IO Signaling -----------------

io.on("connection", async (socket) => {
	const { role, clientId, examId } = socket.handshake.query;
	if (!role || !clientId || !examId) {
		socket.emit("error", { message: "Missing required parameters (role, clientId, examId)" });
		socket.disconnect();
		return;
	}

	// Join a common room based on examId.
	const roomName = `exam:${examId}`;
	socket.join(roomName);
	console.log(`${clientId} connected as ${role} in room ${roomName}`);

	// Get (or create) the Mediasoup room for this exam.
	const examRoom = await getOrCreateExamRoom(examId);

	// --- Basic Signaling for Exam Events ---
	if (role === "examiner") {
		socket.emit("room-assigned", { room: roomName });
	} else if (role === "student") {
		io.to(roomName).emit("new-student", { clientId });
	}

	// --- Mediasoup Signaling Events ---

	// 1. Create a WebRTC Transport (for sending or receiving).
	//    Client sends: { direction: "send" or "recv" }
	socket.on("createTransport", async (data, callback) => {
		const { direction } = data;
		try {
			// Replace "YOUR_PUBLIC_IP" with your server's public IP (or use a dynamic solution).
			const transport = await examRoom.router.createWebRtcTransport({
				listenIps: [{ ip: "YOUR_PUBLIC_IP", announcedIp: "YOUR_PUBLIC_IP" }],
				enableUdp: true,
				enableTcp: true,
				preferUdp: true,
			});
			// Store transport per client.
			examRoom.transports[clientId] = examRoom.transports[clientId] || {};
			examRoom.transports[clientId][direction] = transport;

			callback({
				params: {
					id: transport.id,
					iceParameters: transport.iceParameters,
					iceCandidates: transport.iceCandidates,
					dtlsParameters: transport.dtlsParameters,
					sctpParameters: transport.sctpParameters,
				},
			});
		} catch (err) {
			console.error("Error creating transport:", err);
			callback({ error: err.message });
		}
	});

	// 2. Connect the created transport (client sends its DTLS parameters).
	socket.on("connectTransport", async (data, callback) => {
		const { transportId, dtlsParameters, direction } = data;
		try {
			const transport = examRoom.transports[clientId] && examRoom.transports[clientId][direction];
			if (!transport || transport.id !== transportId) {
				throw new Error("Transport not found");
			}
			await transport.connect({ dtlsParameters });
			callback({ connected: true });
		} catch (err) {
			console.error("Error connecting transport:", err);
			callback({ error: err.message });
		}
	});

	// 3. Producer: A student publishes a media track.
	socket.on("produce", async (data, callback) => {
		const { transportId, kind, rtpParameters, appData } = data;
		try {
			const transport = examRoom.transports[clientId] && examRoom.transports[clientId].send;
			if (!transport || transport.id !== transportId) {
				throw new Error("Send transport not found");
			}
			const producer = await transport.produce({ kind, rtpParameters, appData });
			examRoom.producers[clientId] = producer;

			// Notify others (for example, the examiner) that a new producer is available.
			socket.to(roomName).emit("new-producer", { clientId, kind });
			callback({ id: producer.id });
		} catch (err) {
			console.error("Error producing track:", err);
			callback({ error: err.message });
		}
	});

	// 4. Consumer: An examiner (or any subscriber) consumes a student's media.
	socket.on("consume", async (data, callback) => {
		const { consumerTransportId, producerClientId, rtpCapabilities } = data;
		try {
			const producer = examRoom.producers[producerClientId];
			if (!producer) throw new Error("Producer not found");

			const transport = examRoom.transports[clientId] && examRoom.transports[clientId].recv;
			if (!transport || transport.id !== consumerTransportId) throw new Error("Receive transport not found");

			if (!examRoom.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
				throw new Error("Cannot consume");
			}

			const consumer = await transport.consume({
				producerId: producer.id,
				rtpCapabilities,
				paused: false,
			});

			callback({
				params: {
					id: consumer.id,
					producerId: producer.id,
					kind: consumer.kind,
					rtpParameters: consumer.rtpParameters,
					type: consumer.type,
					producerPaused: consumer.producerPaused,
				},
			});
		} catch (err) {
			console.error("Error consuming track:", err);
			callback({ error: err.message });
		}
	});

	// Handle disconnection: Clean up Mediasoup transports and producers.
	socket.on("disconnect", () => {
		console.log(`${clientId} disconnected from room ${roomName}`);
		if (examRoom.transports[clientId]) {
			for (const direction in examRoom.transports[clientId]) {
				examRoom.transports[clientId][direction].close();
			}
			delete examRoom.transports[clientId];
		}
		if (examRoom.producers[clientId]) {
			examRoom.producers[clientId].close();
			delete examRoom.producers[clientId];
		}
		socket.to(roomName).emit("client-disconnected", { clientId });
	});
});

server.listen(4050, () => {
	console.log("Mediasoup signaling server running on 4050");
});
