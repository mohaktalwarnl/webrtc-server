const express = require("express");
const http = require("http");
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

const server = http.createServer(options, app);
const io = socketIO(server, { cors: { origin: "*" } });

// In-memory storage for examiner and student sockets.
let examinerSocket = null;
const studentSockets = {};

io.on("connection", (socket) => {
	const { role, clientId, examId } = socket.handshake.query;
	const candidateName = socket.handshake.auth?.candidateName ?? socket.handshake.query?.candidateName;

	if (!role || !clientId || !examId) {
		socket.emit("error", { message: "Missing required parameters (role, clientId, examId)" });
		socket.disconnect();
		return;
	}

	const room = `exam:${examId}`;
	socket.join(room);
	sendLog("INFO", `${clientId} connected as ${role} in room ${room}`);
	console.log(`${clientId} connected as ${role} in room ${room}`);

	// Heartbeat handling
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

		// Fetch all active student IDs and notify examiner, but prefer in-memory names
		const url = `${process.env.MONGOAPI_ENDPOINT}/socket/getsocketbyroom/${room}`;
		fetch(url)
			.then((res) => res.json())
			.then((responseData) => {
				if (!responseData.error && responseData.status === 200 && responseData.data && Array.isArray(responseData.data.client_id)) {
					responseData.data.client_id.forEach((client) => {
						const studentId = client.client_id;
						const key = `student_${studentId}`;
						// Prefer the live socket's name if present
						let name = studentSockets[key]?.candidateName || client.user_name || "Unknown";
						console.log(`Notifying examiner of active student ${studentId} as "${name}"`);
						examinerSocket.emit("new-student", {
							clientId: key,
							candidateName: name,
						});
					});
				} else {
					console.error("Failed to fetch active students from external API:", responseData);
				}
			})
			.catch((err) => {
				console.error("Error fetching active students from external API:", err);
			});
	} else if (role === "student") {
		// Persist the name on this socket
		socket.candidateName = candidateName || "Unknown";
		studentSockets[clientId] = socket;
		console.log(`Registered student ${clientId} as "${socket.candidateName}"`);
		// Notify examiner immediately if connected
		if (examinerSocket) {
			examinerSocket.emit("new-student", {
				clientId,
				candidateName: socket.candidateName,
			});
		}
	}

	// Relay signaling messages.
	socket.on("signal", (data) => {
		if (role === "student" && examinerSocket) {
			data.from = clientId;
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
