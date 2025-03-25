const express = require("express");
const https = require("https"); // Use the HTTPS module
const socketIO = require("socket.io");
const fs = require("fs");
const app = express();
require("dotenv").config();

const options = {
	key: fs.readFileSync("/etc/ssl/private/164.52.215.33.key"),
	cert: fs.readFileSync("/etc/ssl/certs/164.52.215.33.crt"),
};

const sendLog = async (level, message, additional_info = {}) => {
	try {
		const logPayload = {
			timestamp: new Date().toISOString(), // ISO formatted UTC timestamp
			service: "signaling-server",
			level: level,
			message: message,
			additional_info: additional_info,
		};

		// Use process.env.LOG_ENDPOINT to specify your log API endpoint
		await fetch(process.env.LOG_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(logPayload),
		});
	} catch (error) {
		console.error("Error sending log:", error);
	}
};

const server = https.createServer(options, app); // Create HTTPS server
const io = socketIO(server, { cors: { origin: "*" } });

// In-memory storage for the examiner and student sockets.
let examinerSocket = null;
const studentSockets = {};

io.on("connection", (socket) => {
	const { role, clientId, examId } = socket.handshake.query;

	if (!role || !clientId || !examId) {
		socket.emit("error", { message: "Missing required parameters (role, clientId, examId)" });
		socket.disconnect();
		return;
	}

	// Use a fixed room for all connections in this exam.
	const room = `exam:${examId}`;
	socket.join(room);
	sendLog("INFO", `${clientId} connected as ${role} in room ${room}`);
	console.log(`${clientId} connected as ${role} in room ${room}`);

	if (role === "examiner") {
		examinerSocket = socket;
		// Optionally notify the examiner of current students:
		socket.emit("room-assigned", { room });
	} else if (role === "student") {
		studentSockets[clientId] = socket;
		// Notify the examiner that a new student has joined.
		if (examinerSocket) {
			examinerSocket.emit("new-student", { clientId });
		}
	}

	// Relay signaling messages.
	socket.on("signal", async (data) => {
		// If the sender is a student, forward its signal to the examiner.
		if (role === "student" && examinerSocket) {
			data.from = clientId;
			examinerSocket.emit("signal", data);
		}
		// If the sender is the examiner:
		if (role === "examiner") {
			// If target is "all", broadcast to every student.
			if (data.target === "all") {
				console.log("Server: Broadcasting ready signal to all students.");
				for (const studentId in studentSockets) {
					studentSockets[studentId].emit("signal", data);
				}
			} else if (data.target) {
				// Otherwise, forward to the specific student.
				const targetSocket = studentSockets[data.target];
				if (targetSocket) {
					targetSocket.emit("signal", data);
				} else {
					sendLog("INFO", `Student socket not found for ${data.target}`);
					console.error(`Student socket not found for ${data.target}`);
				}
			}
		}
	});

	socket.on("disconnect", () => {
		console.log(`${clientId} disconnected from room ${room}`);
		sendLog("INFO", `${clientId} disconnected from room ${room}`);
		if (role === "student") {
			delete studentSockets[clientId];
			if (examinerSocket) {
				examinerSocket.emit("student-disconnected", { clientId });
			}
		}
		if (role === "examiner") {
			examinerSocket = null;
			socket.to(room).emit("examiner-disconnected");
		}
	});
});

server.listen(4050, () => {
	sendLog("INFO", `Simplified signaling server running on 4050`);
	console.log("Simplified signaling server running on 4050");
});
