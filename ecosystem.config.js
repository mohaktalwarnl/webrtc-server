module.exports = {
	apps: [
		{
			name: "webrtc-service",
			script: "server.js",
			instances: "6",
			exec_mode: "cluster",
			sticky: true, // Enable sticky sessions in cluster mode
			watch: false,
			max_memory_restart: "1000G",
			env_file: "./.env",
		},
	],
};
