# Claude Discord Bot + Dashboard

## Setup
1. Discord Developer Portal -> New Application -> Bot. Copy the token. Turn ON "Message Content Intent".
2. Invite it: OAuth2 -> URL Generator -> scopes `bot`; give it the permissions you want it to use
   (Manage Channels, Manage Roles, Moderate Members, Manage Messages, etc.). Put the bot's role ABOVE roles it should manage.
3. `cp .env.example .env`, fill in DISCORD_TOKEN, ANTHROPIC_API_KEY, DASHBOARD_PASSWORD.
4. `npm install && npm start`, then open http://localhost:3000.

## Use
- In Discord, @mention the bot. Chat works for everyone. Server actions (create channels, roles, etc.)
  only run for members with Manage Server or Administrator, and only if enabled in the dashboard.
- In the dashboard, type an instruction in the command bar and the bot carries it out.

## Deploy (Railway / Render)
Set the 3 env vars, start command `npm start`. Add a persistent volume and set DATA_DIR to it so settings survive redeploys.
Never commit your .env file.
