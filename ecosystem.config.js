module.exports = {
	apps: [
		{
			name: "webrtc-service",
			script: "server.js",
			instances: "1",
			exec_mode: "fork",
			watch: false,
			max_memory_restart: "1000G",
		},
	],
};
