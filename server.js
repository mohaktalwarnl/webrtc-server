const express = require("express");
const http = require("http");
const https = require("https");
const cors = require("cors"); /
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const fs = require("fs");
const app = express();
app.use(cors({ origin: "*" }));
require("dotenv").config();

// --- Configuration ---
let serverOptions;
try {
    serverOptions = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH || "/etc/nginx/ssl/STAR.netcomlearning.com.key"),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH || "/etc/nginx/ssl/STAR.netcomlearning.com.ssl-bundle.crt"),
    };
} catch (error) {
    console.error("Warning: Could not read SSL certificates. Server will start without HTTPS.", error.message);
}

const PORT = process.env.PORT || 4050;
const server = serverOptions ? https.createServer(serverOptions, app) : http.createServer(app);

// --- Robust Logging ---
const sendLog = async (level, message, additional_info = {}) => {
	try {
		const logPayload = {
			timestamp: new Date().toISOString(),
			service: "signaling-server",
			level: level,
			message: message,
			additional_info: additional_info,
		};
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		await fetch(process.env.LOG_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(logPayload),
            signal: controller.signal
		});
        clearTimeout(timeoutId);
	} catch (error) {
		console.error("Error sending log:", error.name === 'AbortError' ? 'Request timed out' : error.message);
	}
};

// --- Socket.IO Server Setup ---
const io = new Server(server, {
    cors: {
        origin: "*", // In production, restrict this to your frontend's domain.
    },
    transports: ['websocket', 'polling']
});

// --- Redis Adapter Setup for Scaling ---
// This allows the server to run in a cluster or across multiple machines.
const pubClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Successfully connected to Redis and enabled the Socket.IO Redis Adapter.");
    sendLog("INFO", "Socket.IO adapter connected to Redis.");
}).catch((err) => {
    console.error("FATAL: Could not connect to Redis for Socket.IO Adapter. The application will not work in a cluster.", err);
    sendLog("FATAL", "Could not connect to Redis for Socket.IO adapter.", { error: err.message });
    // In a production environment, you should exit if the adapter fails to connect.
    process.exit(1);
});

// --- Main Socket Logic (Simplified with Adapter) ---
io.on("connection", async (socket) => {
    // 1. Get connection parameters and validate
    const { role, clientId, examId } = socket.handshake.query;
    const candidateName = socket.handshake.auth?.candidateName || "Unknown Candidate";

    if (!role || !clientId || !examId) {
        socket.emit("error", { message: "Connection failed: Missing role, clientId, or examId." });
        socket.disconnect(true);
        return;
    }

    const roomName = `exam:${examId}`;

    // 2. Attach metadata to the socket and join the room.
    // The adapter handles making this information available across the cluster.
    socket.data.role = role;
    socket.data.clientId = clientId;
    socket.data.examId = examId;
    socket.join(roomName);

    const logInfo = { clientId, role, examId, socketId: socket.id };
    console.log(`[Connect] Client connected: ${JSON.stringify(logInfo)}`);
    sendLog("INFO", "Client connected to room", logInfo);

    // 3. Handle connection based on role
    if (role === "examiner") {
        // Fetch all sockets in the room using the adapter
        const socketsInRoom = await io.in(roomName).fetchSockets();
        // Notify the new examiner about all existing students in the room
        for (const remoteSocket of socketsInRoom) {
            if (remoteSocket.data.role === 'student' && remoteSocket.id !== socket.id) {
                socket.emit("new-student", {
                    clientId: remoteSocket.data.clientId,
                    candidateName: remoteSocket.data.candidateName,
                });
            }
        }
    } else if (role === "student") {
        socket.data.candidateName = candidateName;
        // Notify everyone else in the room (i.e., the examiner) about the new student
        socket.to(roomName).emit("new-student", { clientId, candidateName });
    }

    // 4. Handle signaling
    socket.on("signal", async (data) => {
        data.from = socket.data.clientId;
        const targetClientId = data.target;

        if (!targetClientId) {
            // If no target, maybe it's a broadcast-style signal (though you don't have one)
            // or an error. For now, we just ignore.
            return;
        }

        const socketsInRoom = await io.in(roomName).fetchSockets();
        for (const remoteSocket of socketsInRoom) {
            if (remoteSocket.data.clientId === targetClientId) {
                // Found the target socket, send the signal directly to it.
                remoteSocket.emit("signal", data);
                break; // Stop searching once we've sent it.
            }
        }
    });

    // 5. Handle issue reporting
    socket.on("issue_detected", (data) => {
        // Forward the issue to the examiner(s) in the same room
        socket.to(roomName).emit("issue_detected", { ...data, clientId: socket.data.clientId });
    });
    
    // 6. Handle heartbeats
    socket.on("heartbeat", () => {
        socket.emit("heartbeat-ack");
    });

    // 7. Handle disconnects gracefully
    socket.on("disconnect", (reason) => {
        const disconnectInfo = { ...logInfo, reason };
        console.log(`[Disconnect] Client disconnected: ${JSON.stringify(disconnectInfo)}`);
        sendLog("INFO", "Client disconnected from room", disconnectInfo);

        // The adapter automatically handles removing the socket from the room.
        // We just need to notify the other clients.
        if (socket.data.role === 'student') {
            socket.to(roomName).emit("student-disconnected", { clientId: socket.data.clientId });
        } else if (socket.data.role === 'examiner') {
            socket.to(roomName).emit("examiner-disconnected");
        }
    });
});

server.listen(PORT, () => {
	const message = `Signaling server running on port ${PORT}`;
	console.log(message);
	sendLog("INFO", message);
});