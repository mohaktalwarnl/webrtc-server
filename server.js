// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------- Tunables (via env) ----------
// Prefer UDP by default; allow TCP fallback explicitly via env
const ENABLE_TCP = process.env.MS_ENABLE_TCP ? process.env.MS_ENABLE_TCP === "true" : true; // default false
// Keep SFU conservative to suit many small tiles; override via env as needed
const INITIAL_OUT_BITRATE = Number(process.env.MS_INITIAL_OUT_BITRATE || 600_000); // 0.6 Mbps
const MIN_OUT_BITRATE = Number(process.env.MS_MIN_OUT_BITRATE || 200_000); // 0.2 Mbps
// Static low-quality ingress cap targeting ~144p@15fps per publisher
const INGRESS_KBPS = Number(process.env.MS_INGRESS_KBPS || 250); // ~250 kbps

// --- Mediasoup setup ---
let workers = [];
let nextWorkerIdx = 0;

/** @type {Map<string, { router: mediasoup.types.Router, peers: Map<string, any> }>} */
const rooms = new Map();

async function run() {
	await createWorkers();

	io.on("connection", (socket) => {
		console.log(`Client connected [socketId:${socket.id}]`);
		let roomName;

		socket.on("disconnect", () => {
			console.log(`Client disconnected [socketId:${socket.id}]`);
			if (!roomName) return;
			cleanupPeer(roomName, socket.id);
		});

		// ---- Join (kept identical for your frontend) ----
		socket.on("join", async ({ room }, callback) => {
			try {
				roomName = room;
				socket.join(roomName);
				const client_id = socket.handshake.query.client_id;
				const name = socket.handshake.query.name || "Unknown";
				const isExaminer = socket.handshake.query.isExaminer === "true";
				const { router, peers } = await getOrCreateRoom(roomName);

				peers.set(socket.id, {
					transports: new Map(), // id -> transport
					producers: new Map(), // id -> producer
					consumers: new Map(), // id -> consumer
					client_id,
					name,
					isExaminer,
				});

				// Build existing producers list (unchanged shape)
				const existingProducerIds = [];
				for (const [peerSocketId, peer] of peers.entries()) {
					for (const producer of peer.producers.values()) {
						existingProducerIds.push({
							producerId: producer.id,
							kind: producer.kind,
							peerId: peerSocketId,
							client_id: peer.client_id,
							name: peer.name,
						});
					}
				}

				callback({
					rtpCapabilities: router.rtpCapabilities,
					existingProducers: existingProducerIds,
				});
			} catch (e) {
				console.error("Error joining room:", e);
				callback({ error: e.message });
			}
		});

		// Optional convenience (doesn't affect your FE)
		socket.on("get-rtp-capabilities", async (_msg, cb) => {
			try {
				const { router } = rooms.get(roomName) || (await getOrCreateRoom(roomName));
				cb && cb({ rtpCapabilities: router.rtpCapabilities });
			} catch (e) {
				console.error("get-rtp-capabilities error", e);
				cb && cb({ error: e.message });
			}
		});

		// ---- Create transport (kept same return shape) ----
		socket.on("create-transport", async ({ direction }, callback) => {
			try {
				const { router, peers } = rooms.get(roomName);
				const transport = await createWebRtcTransport(router);

				// Store transport
				peers.get(socket.id).transports.set(transport.id, transport);

				// Cap publisher ingress to a static low bitrate (144p@15fps target)
				if (direction === "send") {
					try {
						await transport.setMaxIncomingBitrate(INGRESS_KBPS * 1000);
					} catch {}
				}

				// Cleanup bookkeeping
				transport.on("dtlsstatechange", (dtlsState) => {
					if (dtlsState === "closed") {
						console.log(`Transport closed [peer:${socket.id}]`);
						try {
							transport.close();
						} catch {}
					}
				});
				transport.on("close", () => {
					const peer = rooms.get(roomName)?.peers.get(socket.id);
					if (peer) peer.transports.delete(transport.id);
				});

				callback({
					id: transport.id,
					iceParameters: transport.iceParameters,
					iceCandidates: transport.iceCandidates,
					dtlsParameters: transport.dtlsParameters,
				});
			} catch (e) {
				console.error("Error creating transport:", e);
				callback({ error: e.message });
			}
		});

		// ---- Connect transport (unchanged signature) ----
		socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
			try {
				const transport = rooms.get(roomName).peers.get(socket.id).transports.get(transportId);
				if (!transport) throw new Error(`Transport not found: ${transportId}`);
				await transport.connect({ dtlsParameters });
				callback({ success: true });
			} catch (e) {
				console.error("Error connecting transport:", e);
				callback({ error: e.message });
			}
		});

		// ---- Produce (unchanged) ----
		socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
			try {
				const room = rooms.get(roomName);
				const transport = room.peers.get(socket.id).transports.get(transportId);
				if (!transport) throw new Error(`Transport not found: ${transportId}`);

				const producer = await transport.produce({ kind, rtpParameters });
				room.peers.get(socket.id).producers.set(producer.id, producer);

				// Cleanup on transport close
				producer.on("transportclose", () => {
					console.log(`Producer's transport closed [producerId:${producer.id}]`);
					// remove from owner peer
					const owner = room.peers.get(socket.id);
					if (owner) owner.producers.delete(producer.id);
					// notify room (deduped)
					notifyProducerClosed(roomName, producer.id);
				});
				// Also handle explicit close events (deduped)
				producer.on("close", () => {
					const owner = room.peers.get(socket.id);
					if (owner) owner.producers.delete(producer.id);
					notifyProducerClosed(roomName, producer.id);
				});

				// Notify others (same event name your FE uses)
				socket.to(roomName).emit("new-producer", {
					producerId: producer.id,
					kind: producer.kind,
					peerId: socket.id,
					client_id: room.peers.get(socket.id).client_id,
					name: room.peers.get(socket.id).name,
					isExaminer: room.peers.get(socket.id).isExaminer,
				});

				callback({ id: producer.id });
			} catch (e) {
				console.error("Error producing:", e);
				callback({ error: e.message });
			}
		});

		// ---- Consume (unchanged signature + return shape) ----
		socket.on("consume", async ({ transportId, producerId, rtpCapabilities }, callback) => {
			try {
				const room = rooms.get(roomName);
				const { router } = room;

				if (!router.canConsume({ producerId, rtpCapabilities })) {
					throw new Error(`Client cannot consume [producerId:${producerId}]`);
				}

				const transport = room.peers.get(socket.id).transports.get(transportId);
				if (!transport) throw new Error(`Transport not found: ${transportId}`);

				const consumer = await transport.consume({
					producerId,
					rtpCapabilities,
					paused: true, // client will resume
				});

				room.peers.get(socket.id).consumers.set(consumer.id, consumer);

				// Prefer lowest video layer by default to suit many-tiles layouts
				try {
					if (consumer.kind === "video") {
						await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 1 });
					}
				} catch {}

				consumer.on("transportclose", () => {
					console.log(`Consumer's transport closed [consumerId:${consumer.id}]`);
					room.peers.get(socket.id)?.consumers.delete(consumer.id);
				});
				consumer.on("producerclose", () => {
					console.log(`Associated producer closed [consumerId:${consumer.id}]`);
					socket.emit("consumer-closed", { consumerId: consumer.id });
					room.peers.get(socket.id)?.consumers.delete(consumer.id);
				});

				callback({
					id: consumer.id,
					producerId,
					kind: consumer.kind,
					rtpParameters: consumer.rtpParameters,
				});
			} catch (e) {
				console.error("Error consuming:", e);
				callback({ error: e.message });
			}
		});

		// ---- Resume consumer (unchanged) ----
		socket.on("resume-consumer", async ({ consumerId }, callback) => {
			try {
				const consumer = rooms.get(roomName).peers.get(socket.id).consumers.get(consumerId);
				if (!consumer) throw new Error(`Consumer not found: ${consumerId}`);
				await consumer.resume();
				callback({ success: true });
			} catch (e) {
				console.error("Error resuming consumer:", e);
				callback({ error: e.message });
			}
		});

		// Messaging (unchanged)
		socket.on("private-message", ({ toClientId, message }) => {
			if (!roomName) return;
			const room = rooms.get(roomName);
			if (!room) return;
			const senderPeer = room.peers.get(socket.id);
			if (!senderPeer) return;
			const toSocketEntry = Array.from(room.peers.entries()).find(([, peer]) => peer.client_id === toClientId);
			if (toSocketEntry) {
				const [toSocketId] = toSocketEntry;
				io.to(toSocketId).emit("private-message", {
					fromClientId: senderPeer.client_id,
					fromName: senderPeer.name,
					message,
				});
			}
		});

		socket.on("issue-detected", ({ violationDetails }) => {
			if (!roomName) return;
			const room = rooms.get(roomName);
			if (!room) return;
			const senderPeer = room.peers.get(socket.id);
			if (!senderPeer) return;
			socket.to(roomName).emit("issue-detected", {
				fromClientId: senderPeer.client_id,
				fromName: senderPeer.name,
				violationDetails,
			});
		});
	});

	// register process signal/error handlers once server is initialized
	setupProcessHandlers();

	const PORT = process.env.PORT || 4000;
	server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

/** ---------- Helpers ---------- */
async function createWorkers() {
	const numWorkers = os.cpus().length;
	console.log(`Creating ${numWorkers} mediasoup workers...`);
	for (let i = 0; i < numWorkers; i++) {
		const worker = await mediasoup.createWorker({
			logLevel: "warn",
			rtcMinPort: 40000,
			rtcMaxPort: 49999,
		});
		worker.on("died", () => {
			console.error(`mediasoup worker ${worker.pid} has died; starting graceful shutdown...`);
			gracefulShutdown(1);
		});
		workers.push(worker);
	}
}

function getNextWorker() {
	const worker = workers[nextWorkerIdx];
	nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
	return worker;
}

async function getOrCreateRoom(roomName) {
	let room = rooms.get(roomName);
	if (!room) {
		const worker = getNextWorker();
		const router = await worker.createRouter({
			mediaCodecs: [
				// Opus (2 channels for widest compatibility), enable in-band FEC
				{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 } },
				// VP8 (Chrome/Firefox/Edge)
				{ kind: "video", mimeType: "video/VP8", clockRate: 90000 },
				// VP9 (SVC capable) for clients that publish scalable streams
				{ kind: "video", mimeType: "video/VP9", clockRate: 90000, parameters: { "profile-id": 2 } },
				// H.264 (Safari, plus a safe fallback)
				{
					kind: "video",
					mimeType: "video/H264",
					clockRate: 90000,
					parameters: {
						"packetization-mode": 1,
						"profile-level-id": "42e01f",
						"level-asymmetry-allowed": 1,
					},
				},
			],
		});
		room = { router, peers: new Map(), notifiedClosedProducers: new Set() };
		rooms.set(roomName, room);
		console.log(`Room created [roomName:${roomName}]`);
	}
	return room;
}

let shuttingDown = false;
function setupProcessHandlers() {
	process.on("SIGINT", () => gracefulShutdown(0));
	process.on("SIGTERM", () => gracefulShutdown(0));
	process.on("uncaughtException", (err) => {
		console.error("uncaughtException", err);
		gracefulShutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error("unhandledRejection", reason);
		gracefulShutdown(1);
	});
}

async function gracefulShutdown(exitCode) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("Starting graceful shutdown...");
	try {
		// Stop accepting new connections
		try {
			io.close();
		} catch {}
		try {
			server.close(() => {});
		} catch {}

		// Close rooms
		for (const [roomName, room] of rooms.entries()) {
			for (const [socketId, peer] of room.peers.entries()) {
				for (const transport of peer.transports.values()) {
					try {
						transport.close();
					} catch {}
				}
				for (const producer of peer.producers.values()) {
					try {
						producer.close();
					} catch {}
					notifyProducerClosed(roomName, producer.id);
				}
				for (const consumer of peer.consumers.values()) {
					try {
						consumer.close();
					} catch {}
				}
				room.peers.delete(socketId);
			}
			try {
				room.router.close();
			} catch {}
			rooms.delete(roomName);
		}

		// Close workers
		for (const worker of workers) {
			try {
				await worker.close?.();
			} catch {}
		}
	} finally {
		setTimeout(() => process.exit(typeof exitCode === "number" ? exitCode : 0), 200);
	}
}

function cleanupPeer(roomName, socketId) {
	const room = rooms.get(roomName);
	if (!room) return;

	const peer = room.peers.get(socketId);
	if (!peer) return;

	console.log(`Cleaning up peer [socketId:${socketId}]`);

	// Closing transports cascades producer/consumer cleanup
	for (const transport of peer.transports.values()) {
		try {
			transport.close();
		} catch {}
	}

	// Notify others that this peer's producers are gone (deduped)
	for (const producer of peer.producers.values()) {
		try {
			producer.close();
		} catch {}
		notifyProducerClosed(roomName, producer.id);
	}

	room.peers.delete(socketId);

	// If room empty, free router
	if (room.peers.size === 0) {
		console.log(`Room is empty, closing router [roomName:${roomName}]`);
		try {
			room.router.close();
		} catch {}
		rooms.delete(roomName);
	}
}

// Emit producer-closed once per producerId per room
function notifyProducerClosed(roomName, producerId) {
	const room = rooms.get(roomName);
	if (!room) return;
	if (room.notifiedClosedProducers.has(producerId)) return;
	room.notifiedClosedProducers.add(producerId);
	io.to(roomName).emit("producer-closed", { producerId });
}

async function createWebRtcTransport(router) {
	const transport = await router.createWebRtcTransport({
		listenIps: [{ ip: "0.0.0.0", announcedIp: process.env.PUBLIC_IP }],
		enableUdp: true,
		enableTcp: true, // keep your original default; can turn off via env for perf
		preferUdp: true,
		initialAvailableOutgoingBitrate: INITIAL_OUT_BITRATE,
		minimumAvailableOutgoingBitrate: MIN_OUT_BITRATE,
	});
	return transport;
}

// Start the server
run();
