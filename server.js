
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Allow requests from anywhere (your Claude artifact, local dev, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "ncaa-scores-proxy" }));

// Live scores — proxies ESPN's public scoreboard
app.get("/scores", async (req, res) => {
  try {
    const url =
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=200";

    const response = await fetch(url);
    if (!response.ok) throw new Error(`ESPN returned ${response.status}`);

    const data = await response.json();

    const games = (data.events || []).map((ev) => {
      const comp     = ev.competitions?.[0];
      const homeComp = comp?.competitors?.find((c) => c.homeAway === "home");
      const awayComp = comp?.competitors?.find((c) => c.homeAway === "away");
      if (!homeComp || !awayComp) return null;

      const statusType = ev.status?.type?.name || "";
      const status =
        statusType === "STATUS_IN_PROGRESS" || statusType === "STATUS_HALFTIME"
          ? "live"
          : statusType === "STATUS_FINAL"
          ? "final"
          : "upcoming";

      return {
        id:         ev.id,
        home:       homeComp.team?.displayName || homeComp.team?.name,
        away:       awayComp.team?.displayName || awayComp.team?.name,
        homeAbbr:   homeComp.team?.abbreviation?.toUpperCase(),
        awayAbbr:   awayComp.team?.abbreviation?.toUpperCase(),
        homeRecord: homeComp.records?.[0]?.summary || null,
        awayRecord: awayComp.records?.[0]?.summary || null,
        status,
        homeScore:  status !== "upcoming" ? parseInt(homeComp.score, 10) || 0 : null,
        awayScore:  status !== "upcoming" ? parseInt(awayComp.score, 10) || 0 : null,
        clock:      ev.status?.type?.shortDetail || null,
        startTime:  ev.date,
        espnSpread: comp?.odds?.[0]?.details || null,
        espnOU:     comp?.odds?.[0]?.overUnder || null,
      };
    }).filter(Boolean);

    res.json({ games, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("ESPN fetch error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// AI matchup analysis — proxies Anthropic API (keeps key server-side)
app.post("/analyse", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    res.json({ text });
  } catch (err) {
    console.error("Analyse error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
