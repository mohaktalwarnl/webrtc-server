const express = require("express");
const http =require("http");
const https = require("https"); // Use https for creating server with options
const socketIO = require("socket.io");
const fs = require("fs");
const app = express();
require("dotenv").config();

// --- Configuration ---
// It's better to load credentials once and handle potential errors
let serverOptions;
try {
    serverOptions = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH || "/etc/nginx/ssl/STAR.netcomlearning.com.key"),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH || "/etc/nginx/ssl/STAR.netcomlearning.com.ssl-bundle.crt"),
    };
} catch (error) {
    console.error("Error reading SSL certificates. The server will start without HTTPS, which is not recommended for production WebRTC.", error);
    // For local development, you might not have SSL.
    // In a real prod setup, this failure should likely prevent the server from starting.
}

const PORT = process.env.PORT || 4050;

// --- Robust Logging ---
// Your logging function is good. Let's keep it.
const sendLog = async (level, message, additional_info = {}) => {
	try {
		const logPayload = {
			timestamp: new Date().toISOString(),
			service: "signaling-server",
			level: level,
			message: message,
			additional_info: additional_info,
		};
		// Use a timeout for fetch to prevent it from hanging indefinitely
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout

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

// --- Server Setup ---
// Use the https module if SSL certs are available, otherwise http
const server = serverOptions ? https.createServer(serverOptions, app) : http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*", // In production, restrict this to your frontend's domain: e.g., "https://yourapp.com"
    },
    // This is crucial for performance and resilience
    transports: ['websocket', 'polling']
});

// --- State Management: The Core of the Solution ---
// We will store all room information here.
// The key is the room name (e.g., 'exam:exam123'), and the value is the room's state.
const rooms = new Map();

/**
 *  Room State Structure:
 *  {
 *      examiner: { socketId: string, clientId: string } | null,
 *      students: Map<string, { socketId: string, candidateName: string }>
 *  }
 */

// --- Helper Functions ---
function getRoom(examId) {
    return `exam:${examId}`;
}

function cleanupRoomIfEmpty(roomName) {
    const room = rooms.get(roomName);
    if (room && !room.examiner && room.students.size === 0) {
        rooms.delete(roomName);
        console.log(`[Cleanup] Removed empty room: ${roomName}`);
        sendLog("INFO", `[Cleanup] Removed empty room: ${roomName}`);
    }
}

// --- Socket.IO Connection Logic ---
io.on("connection", (socket) => {
    // 1. Get connection parameters and validate
	const { role, clientId, examId } = socket.handshake.query;
	const candidateName = socket.handshake.auth?.candidateName || socket.handshake.query?.candidateName || "Unknown Candidate";

	if (!role || !clientId || !examId) {
		socket.emit("error", { message: "Connection failed: Missing role, clientId, or examId." });
		socket.disconnect(true);
		return;
	}

    const roomName = getRoom(examId);
    socket.join(roomName);

    // 2. Initialize room if it doesn't exist
    if (!rooms.has(roomName)) {
        rooms.set(roomName, {
            examiner: null,
            students: new Map()
        });
    }
    const room = rooms.get(roomName);

    console.log(`[Connect] Client '${clientId}' (${role}) joined room '${roomName}'`);
    sendLog("INFO", `Client connected`, { clientId, role, roomName, socketId: socket.id });


    // 3. Handle connection based on role
    if (role === "examiner") {
        if (room.examiner) {
            // An examiner is already in this room. This could be a reconnect or an error.
            // For now, we disconnect the new connection. A more advanced system could handle take-overs.
            socket.emit("error", { message: "An examiner is already present in this exam room." });
            socket.disconnect(true);
            return;
        }
        
        room.examiner = { socketId: socket.id, clientId };
        console.log(`[Examiner] Examiner '${clientId}' registered for room '${roomName}'`);

        // **THIS REPLACES THE HACK**: Inform the newly connected examiner of all students already in the room.
        if (room.students.size > 0) {
            console.log(`[Examiner] Notifying examiner about ${room.students.size} existing students.`);
            const studentList = Array.from(room.students.entries()).map(([studentClientId, studentData]) => ({
                clientId: studentClientId,
                candidateName: studentData.candidateName
            }));
            // Send all students in one go, or one-by-one. Your FE handles one-by-one, so let's stick to that.
            studentList.forEach(student => {
                socket.emit("new-student", student);
            });
        }

    } else if (role === "student") {
        room.students.set(clientId, { socketId: socket.id, candidateName });
        console.log(`[Student] Student '${clientId}' (${candidateName}) registered for room '${roomName}'`);

        // If an examiner is already present, notify them of this new student.
        if (room.examiner) {
            io.to(room.examiner.socketId).emit("new-student", { clientId, candidateName });
        }
    }


    // 4. Handle signaling
    socket.on("signal", (data) => {
        // Add source clientId to all signals for context
        data.from = clientId;
        const targetClientId = data.target;

        if (role === 'examiner') {
            const student = room.students.get(targetClientId);
            if (student) {
                io.to(student.socketId).emit("signal", data);
            } else {
                console.error(`[Signal] Examiner tried to signal non-existent student: ${targetClientId}`);
                sendLog("WARN", `Signal target not found`, { from: clientId, target: targetClientId, roomName });
            }
        } else { // Role is 'student'
            if (room.examiner) {
                io.to(room.examiner.socketId).emit("signal", data);
            } else {
                console.warn(`[Signal] Student '${clientId}' sent a signal, but no examiner is in the room.`);
                // Optionally, you could queue this signal, but it's often better to let the FE retry.
            }
        }
    });


    // 5. Handle issue reporting
    socket.on("issue_detected", (data) => {
        if (room.examiner) {
            // Forward the issue, enriching it with the source clientId
            io.to(room.examiner.socketId).emit("issue_detected", { ...data, clientId });
        }
    });
    
    // 6. Handle heartbeats (good for detecting dead sockets)
    socket.on("heartbeat", () => {
        socket.emit("heartbeat-ack");
    });


    // 7. Handle disconnects gracefully
    socket.on("disconnect", (reason) => {
        console.log(`[Disconnect] Client '${clientId}' (${role}) disconnected. Reason: ${reason}`);
        sendLog("INFO", `Client disconnected`, { clientId, role, roomName, reason });

        const roomToClean = rooms.get(roomName);
        if (!roomToClean) return;

        if (role === "examiner" && roomToClean.examiner?.socketId === socket.id) {
            roomToClean.examiner = null;
            // Inform all students in that specific room that the examiner left
            socket.to(roomName).emit("examiner-disconnected");
            console.log(`[Examiner] Examiner left room '${roomName}'. Notifying students.`);
        } else if (role === "student") {
            roomToClean.students.delete(clientId);
            // Inform the examiner in that specific room
            if (roomToClean.examiner) {
                io.to(roomToClean.examiner.socketId).emit("student-disconnected", { clientId });
            }
        }
        
        cleanupRoomIfEmpty(roomName);
    });
});

server.listen(PORT, () => {
	const message = `Signaling server running on port ${PORT}`;
	console.log(message);
	sendLog("INFO", message);
});