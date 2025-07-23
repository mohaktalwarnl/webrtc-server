module.exports = {
	apps: [
		{
			name: "webrtc-service",
			script: "server.js",
			instances: "3",
			exec_mode: "cluster",
			watch: false,
			max_memory_restart: "1000G",
			env_file: "./.env",
		},
	],
};
