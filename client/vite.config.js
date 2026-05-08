import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    build: {
          outDir: "../dist",
          emptyOutDir: true,
          rollupOptions: {
                  output: {
                            manualChunks(id) {
                                        if (id.includes("node_modules")) {
                                                      if (id.includes("react-router") || id.includes("react-dom") || id.includes("/react/")) return "vendor";
                                                      if (id.includes("@tanstack")) return "query";
                                                      if (id.includes("leaflet")) return "leaflet";
                                        }
                            },
                  },
          },
    },
    server: {
          port: 5173,
          proxy: {
                  "/api": {
                            target: process.env.VITE_API_URL || "http://localhost:5000",
                            changeOrigin: true,
                  },
                  "/uploads": {
                            target: process.env.VITE_API_URL || "http://localhost:5000",
                            changeOrigin: true,
                  },
          },
    },
});
