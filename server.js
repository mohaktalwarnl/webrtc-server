const express = require("express");
const https = require("https");
const socketIO = require("socket.io");
const fs = require("fs");
const app = express();
require("dotenv").config();

const options = {
	key: fs.readFileSync("/etc/nginx/ssl/STAR.netcomlearning.com.key"),
	cert: fs.readFileSync("/etc/nginx/ssl/STAR.netcomlearning.com.ssl-bundle.crt"),
};

const sendLog = async (level, message, additional_info = {}) => {
	try {
		const logPayload = {
			timestamp: new Date().toISOString(),
			service: "signaling-server",
			level: level,
			message: message,
			additional_info: additional_info,
		};

		await fetch(process.env.LOG_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(logPayload),
		});
	} catch (error) {
		console.error("Error sending log:", error);
	}
};

const server = https.createServer(options, app);
const io = socketIO(server, { cors: { origin: "*" } });

// In-memory storage for examiner and student sockets.
let examinerSocket = null;
const studentSockets = {};

io.on("connection", (socket) => {
	const { role, clientId, examId, candidateName } = socket.handshake.query;

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

	// Heartbeat handling: reply to heartbeat pings from clients.
	socket.on("heartbeat", (data) => {
		console.log(`Received heartbeat from ${data.clientId} in exam ${data.examId}`);
		socket.emit("heartbeat-ack", { timestamp: Date.now(), message: "pong" });
	});

	socket.on("issue_detected", (data) => {
		if (examinerSocket) {
			examinerSocket.emit("issue_detected", data);
		}
	});

	if (role === "examiner") {
		examinerSocket = socket;
		socket.emit("room-assigned", { room });

		// When examiner joins, fetch all active student client IDs from external API.
		// We assume the external API uses examId as the room identifier.
		const url = `${process.env.MONGOAPI_ENDPOINT}/socket/getsocketbyroom/${room}`;
		fetch(url)
			.then((res) => res.json())
			.then((responseData) => {
				if (!responseData.error && responseData.status === 200 && responseData.data && Array.isArray(responseData.data.client_id)) {
					responseData.data.client_id.forEach((client) => {
						// Check if the student socket has a candidateName; if not, default to "Unknown"
						let name = client.user_name || "Unknown";
						let studentId = client.client_id;
						// if (studentSockets[studentId] && studentSockets[studentId].candidateName) {
						// 	name = studentSockets[studentId].candidateName;
						// }
						console.log(`Notifying examiner of active student: ${studentId}`);
						examinerSocket.emit("new-student", { clientId: `student_${studentId}`, candidateName: name });
					});
				} else {
					console.error("Failed to fetch active students from external API:", responseData);
				}
			})
			.catch((err) => {
				console.error("Error fetching active students from external API:", err);
			});
	} else if (role === "student") {
		// Store candidateName on the student socket (using a default if not provided)
		socket.candidateName = candidateName || "Unknown";
		studentSockets[clientId] = socket;
		// Immediately notify examiner if already connected.
		if (examinerSocket) {
			examinerSocket.emit("new-student", { clientId, candidateName: socket.candidateName });
		}
	}

	// Relay signaling messages.
	socket.on("signal", (data) => {
		if (role === "student" && examinerSocket) {
			data.from = clientId;
			// Always include candidateName from the student socket.
			data.candidateName = socket.candidateName;
			examinerSocket.emit("signal", data);
		}
		if (role === "examiner") {
			if (data.target === "all") {
				console.log("Server: Broadcasting ready signal to all students.");
				for (const studentId in studentSockets) {
					studentSockets[studentId].emit("signal", data);
				}
			} else if (data.target) {
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
