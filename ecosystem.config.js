module.exports = {
	apps: [
		{
			name: "webrtc-service", // Application name for PM2
			script: "server.js", // Entry point of your app (change as needed)
			instances: "6", // Scales to all available CPU cores
			exec_mode: "cluster", // Enables cluster mode
			watch: false, // Set to true if you want PM2 to watch file changes (useful in development)
			max_memory_restart: "1000G", // Restarts the app if it uses more than 500 MB of memory
			env_file: "./.env",
		},
	],
};
