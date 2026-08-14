Stock Scanner

A real-time momentum stock scanner built with React. Screens equities against a 5-pillar model to surface low-float names showing signs of explosive demand.

The 5 pillars

Relative volume (RVol): today's volume vs. a baseline. Total volume: raw shares traded. Gap / % gain: move from prior close. Price range: $2–$20. Float: shares available to trade, where lower float means more price-sensitivity to volume.

Each ticker is scored 0–5 based on how many pillars it currently clears, shown as dots in the Signal column. A 5/5 score is flagged as an explosive setup.

Tech stack

React (functional components and hooks), built with Vite. Live data comes from Polygon.io (now Massive) via its market snapshot REST API, with Finnhub's company profile API used for float data. Icons are from lucide-react. There's no backend; the app runs entirely client-side, polling REST endpoints on an interval rather than using a websocket.

Data modes

Simulated mode is the default and generates fake tickers for testing the UI, no API key needed. Live mode requires a paid Polygon/Massive plan, since the free tier doesn't include the snapshot endpoint, and polls every 15 seconds. EOD fallback mode kicks in automatically if a Polygon key hits a 403 on the live endpoint; it compares the two most recent completed trading sessions instead of live data, refreshed every 5 minutes.

Setup

Run npm install followed by npm run dev. Open the app, click Criteria, and paste in your API keys, which are kept in-session only and never persisted or committed. A Polygon.io key is required for live or EOD data, and a Finnhub key is optional and enables the float column.

Known limitations

RVol is computed as today's volume divided by prior-day volume, a proxy rather than a true 20-day average. Float comes from Finnhub's shares-outstanding figure, not true tradeable float, since that excludes insider and locked shares. This is a screener only, with no order execution, alerts, or backtesting. It is not financial advice and has not been validated against live trading performance.