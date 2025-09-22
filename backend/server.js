// backend/server.js (CommonJS) -- serves login first, then file manager after login
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Client } = require("minio");
const cors = require("cors");

const BUCKET = "uploads";
const app = express();
const PORT = 4000;

// --- Load config (username/password) ---
const CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ Missing backend/config.json. Create one with { \"username\": \"admin\", \"password\": \"secret\" }");
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// --- Middleware ---
app.use(cors());
app.use(express.urlencoded({ extended: true })); // form posts (login form)
app.use(express.json());

// sessions
app.use(
  session({
    secret: CONFIG.sessionSecret || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // set true if HTTPS
  })
);

// --- MinIO client ---
const minioClient = new Client({
  endPoint: "localhost",
  port: 9000,
  useSSL: false,
  accessKey: "novacron",
  secretKey: "ccproject",
});

// --- Multer (memory storage so we stream to MinIO) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Authentication helpers ---
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.headers.accept && req.headers.accept.indexOf("application/json") !== -1) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login");
}

// Intercept requests for root/index.html
app.use((req, res, next) => {
  if (
    req.path === "/login" ||
    req.path === "/do-login" ||
    req.path === "/logout" ||
    req.path.startsWith("/public/") ||
    req.path.startsWith("/assets/") ||
    req.path.startsWith("/static/") ||
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  if ((req.path === "/" || req.path === "/index.html") && (!req.session || !req.session.user)) {
    return res.redirect("/login");
  }

  next();
});

// --- Serve static files ---
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// --- LOGIN ROUTES ---

// Login page (GET)
app.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");
  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Handle login form POST (HTML form)
app.post("/do-login", (req, res) => {
  const { username, password } = req.body;

  const user = CONFIG.find(u => u.username === username && u.password === password);

if (user) {
  req.session.user = user.username;
  return res.redirect("/");
}

  // If login fails → read login.html and inject error
  const loginHtmlPath = path.join(__dirname, "public", "login.html");
  fs.readFile(loginHtmlPath, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read login.html:", err);
      return res.status(500).send("Server error");
    }

    const errorNotice = `
      <div class="alert alert-danger mt-3" role="alert">
        Invalid credentials
      </div>
    `;

    // Inject error into placeholder
    const modifiedHtml = data.replace(
      '<div id="errorBox"></div>',
      `<div id="errorBox">${errorNotice}</div>`
    );

    res.send(modifiedHtml);
  });
});

// Handle JSON/AJAX login
app.post("/login", (req, res) => {
  const { username, password, remember } = req.body;
  const user = CONFIG.find(u => u.username === username && u.password === password);

  if (user) {
    req.session.user = user.username;
    if (remember) req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
    else req.session.cookie.expires = false;
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: "Invalid credentials" });
});


// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    return res.redirect("/login");
  });
});

// --- MAIN APP ROUTES ---

// Main page
app.get("/", requireLogin, (req, res) => {
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload → MinIO
app.post("/upload", requireLogin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const fileBuffer = req.file.buffer;
  const originalName = req.file.originalname;
  const fileName = `${Date.now()}-${originalName}`;

  minioClient.putObject(BUCKET, fileName, fileBuffer, (err) => {
    if (err) {
      console.error("MinIO putObject error:", err);
      return res.status(500).json({ error: "Upload failed" });
    }
    return res.json({ success: true, fileName });
  });
});

// List files
app.get("/files", requireLogin, (req, res) => {
  const files = [];
  const stream = minioClient.listObjectsV2(BUCKET, "", true);

  stream.on("data", (obj) => files.push(obj.name));
  stream.on("error", (err) => {
    console.error("listObjectsV2 error:", err);
    return res.status(500).json({ error: "Failed to list files" });
  });
  stream.on("end", () => res.json(files));
});

// Download file
app.get("/download/:filename", requireLogin, (req, res) => {
  const filename = req.params.filename;
  minioClient.getObject(BUCKET, filename, (err, dataStream) => {
    if (err) {
      console.error("getObject error:", err);
      return res.status(404).send("File not found");
    }
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filename)}"`);
    dataStream.pipe(res);
  });
});

// Delete file
app.delete("/delete/:filename", requireLogin, (req, res) => {
  const filename = req.params.filename;
  minioClient.removeObject(BUCKET, filename, (err) => {
    if (err) {
      console.error("removeObject error:", err);
      return res.status(500).json({ error: "Delete failed" });
    }
    return res.json({ success: true, fileName: filename });
  });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
