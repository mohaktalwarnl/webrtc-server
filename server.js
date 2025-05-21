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

let examinerSocket = null;
const studentSockets = {};

io.on("connection", (socket) => {
	const { role, clientId, examId } = socket.handshake.query;
	const candidateName = socket.handshake.auth?.candidateName ?? socket.handshake.query?.candidateName;

	if (!role || !clientId || !examId) {
		socket.emit("error", { message: "Missing parameters" });
		socket.disconnect();
		return;
	}

	const room = `exam:${examId}`;
	socket.join(room);
	sendLog("INFO", `${clientId} connected as ${role} in room ${room}`);
	console.log(`${clientId} connected as ${role} in room ${room}`);

	socket.on("heartbeat", (data) => {
		console.log(`Received heartbeat from ${data.clientId} in exam ${data.examId}`);
		socket.emit("heartbeat-ack", { timestamp: Date.now(), message: "pong" });
	});

	socket.on("issue_detected", (data) => {
		if (examinerSocket) examinerSocket.emit("issue_detected", data);
	});

	if (role === "examiner") {
		examinerSocket = socket;
		socket.emit("room-assigned", { room });

		const url = `${process.env.MONGOAPI_ENDPOINT}/socket/getsocketbyroom/${room}`;
		fetch(url)
			.then((r) => r.json())
			.then((body) => {
				if (body.status === 200 && Array.isArray(body.data.client_id)) {
					body.data.client_id.forEach((c) => {
						const id = c.client_id;
						const name = studentSockets[id]?.candidateName || c.user_name || "Unknown";
						console.log(`Notifying examiner of active student ${id} as "${name}"`);
						examinerSocket.emit("new-student", { clientId: id, candidateName: name });
					});
				}
			})
			.catch((e) => console.error("Fetch error:", e));
	} else if (role === "student") {
		socket.candidateName = candidateName || "Unknown";
		studentSockets[clientId] = socket;
		console.log(`Registered student ${clientId} as "${socket.candidateName}"`);
		if (examinerSocket) {
			examinerSocket.emit("new-student", { clientId, candidateName: socket.candidateName });
		}
	}

	socket.on("signal", (data) => {
		if (role === "student" && examinerSocket) {
			data.from = clientId;
			data.candidateName = socket.candidateName;
			examinerSocket.emit("signal", data);
		}
		if (role === "examiner") {
			const tgt = data.target;
			if (tgt === "all") {
				Object.values(studentSockets).forEach((s) => s.emit("signal", data));
			} else if (tgt) {
				const s = studentSockets[tgt];
				if (s) {
					s.emit("signal", data);
				} else {
					sendLog("INFO", `Student socket not found for ${tgt}`);
					console.error(`Student socket not found: ${tgt}`);
				}
			}
		}
	});

	socket.on("disconnect", () => {
		console.log(`${clientId} disconnected`);
		sendLog("INFO", `${clientId} disconnected`);
		if (role === "student") {
			delete studentSockets[clientId];
			if (examinerSocket) examinerSocket.emit("student-disconnected", { clientId });
		}
		if (role === "examiner") {
			examinerSocket = null;
			socket.to(room).emit("examiner-disconnected");
		}
	});
});

server.listen(4050, () => {
	sendLog("INFO", "Signaling server running on 4050");
	console.log("Server listening on 4050");
});
