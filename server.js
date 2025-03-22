const express = require("express");
const https = require("https"); // Use the HTTPS module
const socketIO = require("socket.io");
const fs = require("fs");
const app = express();

const options = {
	key: fs.readFileSync("/etc/ssl/private/164.52.215.33.key"),
	cert: fs.readFileSync("/etc/ssl/certs/164.52.215.33.crt"),
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
		if (role === "student" && examinerSocket) {
			data.from = clientId;
			examinerSocket.emit("signal", data);
		}
		if (role === "examiner" && data.target) {
			const targetSocket = studentSockets[data.target];
			if (targetSocket) {
				targetSocket.emit("signal", data);
			} else {
				console.error(`Student socket not found for ${data.target}`);
			}
		}
	});

	socket.on("disconnect", () => {
		console.log(`${clientId} disconnected from room ${room}`);
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
	console.log("Simplified signaling server running on 4050");
});
