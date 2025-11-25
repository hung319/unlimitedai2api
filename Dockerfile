# Dockerfile
FROM oven/bun:1

WORKDIR /app
COPY index.ts .

# Expose port 3000
EXPOSE 3000

# Chạy server
CMD ["bun", "run", "index.ts"]
