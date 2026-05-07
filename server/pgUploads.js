/**
 * pgUploads.js — File upload handler
 * Supports local disk storage (default) with optional Cloudflare R2.
 * 
 * For production: Set UPLOAD_PROVIDER=r2 and configure R2 env vars.
 * For development: Files are stored locally in /uploads
 */
const fs = require("fs");
const path = require("path");

// ── Cloudflare R2 upload (optional) ──────────────────────────────────────────
async function uploadToR2(filePath, fileName) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!accountId || !accessKey || !secretKey || !bucket) return null;

  try {
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const contentType = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".pdf": "application/pdf",
    }[ext] || "application/octet-stream";

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: fileName,
      Body: fileBuffer,
      ContentType: contentType,
    }));
    return publicUrl ? `${publicUrl}/${fileName}` : null;
  } catch (e) {
    console.error("[r2] Upload failed:", e.message);
    return null;
  }
}

// Mirror uploaded file to R2 if configured
async function mirrorToCloud(localPath, fileName) {
  if (process.env.UPLOAD_PROVIDER !== "r2") return;
  await uploadToR2(localPath, fileName).catch(e => console.error("[pguploads] mirror:", e.message));
}

// Fallback middleware — for cloud-only deployments
function makeUploadFallback(uploadRoot) {
  return (req, res, next) => {
    // Local file not found — if R2 configured, redirect to R2 URL
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (publicUrl && process.env.UPLOAD_PROVIDER === "r2") {
      const fileName = req.path.replace(/^\//, "");
      return res.redirect(302, `${publicUrl}/${fileName}`);
    }
    next();
  };
}

module.exports = { mirrorToCloud, makeUploadFallback };
