# Use official Node.js LTS image as the base
FROM node:20

# Set NODE_ENV environment variable
ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code, including modules and utils directories
COPY modules ./modules
COPY utils ./utils
COPY . .

# Expose port (change if your app uses a different port)
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]