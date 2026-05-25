const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = process.env.STRING_SESSION;

const postUrlsInput = process.env.POST_URLS || process.env.POST_URL || "";
const postUrls = postUrlsInput.split(/\s+/).filter(url => url.trim() && url.startsWith('http'));

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"|?*\\/()]/g, '_').replace(/\s+/g, '_');
}

async function extractChatAndMsgId(url) {
  const patterns = [
    /https?:\/\/t\.me\/(?:c\/)?([^\/]+)\/(\d+)/,
    /https?:\/\/telegram\.me\/(?:c\/)?([^\/]+)\/(\d+)/,
  ];
  let match = null;
  for (const pattern of patterns) {
    match = url.match(pattern);
    if (match) break;
  }
  if (!match) {
    throw new Error(`Invalid Telegram post URL format: ${url}`);
  }
  let chatId = match[1];
  const msgId = parseInt(match[2]);
  if (chatId === 'c' || chatId.startsWith('c/')) {
    chatId = '-100' + chatId.replace('c/', '').replace('c', '');
  } else if (!isNaN(parseInt(chatId)) && chatId.length > 5) {
    chatId = '-100' + chatId;
  }
  return { chatId, msgId };
}

async function downloadMediaFile(client, media, outputPath, fileName) {
  return new Promise(async (resolve, reject) => {
    try {
      let lastPercent = 0;
      const filePath = await client.downloadMedia(media, {
        outputFile: outputPath,
        progressCallback: (downloaded, total) => {
          const percent = (downloaded / total * 100);
          if (Math.floor(percent / 10) > Math.floor(lastPercent / 10) || percent === 100) {
            lastPercent = percent;
            console.log(`      📊 ${percent.toFixed(0)}% (${(downloaded/1024/1024).toFixed(1)}MB / ${(total/1024/1024).toFixed(1)}MB)`);
          }
        }
      });
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        console.log(`   ✅ Downloaded: ${fileName} (${(fs.statSync(filePath).size/1024/1024).toFixed(2)}MB)`);
        resolve(filePath);
      } else {
        reject(new Error("Download failed"));
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function getOriginalFileName(media) {
  if (media.document && media.document.attributes) {
    for (const attr of media.document.attributes) {
      if (attr.className === 'DocumentAttributeFilename') {
        let name = sanitizeFilename(attr.fileName);
        name = name.replace(/[()]/g, '');
        return name;
      }
    }
  }
  return null;
}

async function getFileExtension(filePath) {
  try {
    const fileType = execSync(`file --mime-type -b "${filePath}"`).toString().trim();
    const extMap = {
      'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
      'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
      'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp',
      'application/pdf': '.pdf', 'application/zip': '.zip',
      'application/x-rar': '.rar'
    };
    return extMap[fileType] || '';
  } catch {
    return '';
  }
}

async function downloadPost(client, postUrl) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📌 Processing: ${postUrl}`);
  console.log(`${'='.repeat(50)}`);
  const { chatId, msgId } = await extractChatAndMsgId(postUrl);
  let chat;
  if (chatId.toString().startsWith('-100')) {
    chat = await client.getEntity(parseInt(chatId));
  } else {
    chat = await client.getEntity(chatId);
  }
  let channelName = "unknown_channel";
  if (chat.username) {
    channelName = chat.username;
  } else if (chat.title) {
    channelName = sanitizeFilename(chat.title);
  } else {
    channelName = chatId.toString().replace('-100', '');
  }
  const messages = await client.getMessages(chat, { ids: msgId });
  const message = messages[0];
  if (!message) {
    throw new Error(`Message ${msgId} not found`);
  }
  console.log(`✅ Channel: ${channelName}`);
  console.log(`✅ Post ID: ${msgId}`);
  const folderName = `${channelName}_${msgId}`;
  const postDir = `/tmp/telegram_downloads/${folderName}`;
  fs.mkdirSync(postDir, { recursive: true });
  if (message.media) {
    console.log(`📥 Downloading media...`);
    let originalFileName = await getOriginalFileName(message.media);
    const tempPath = path.join(postDir, 'temp_download');
    try {
      await downloadMediaFile(client, message.media, tempPath, originalFileName || 'media');
      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        const ext = await getFileExtension(tempPath);
        let finalFileName;
        if (originalFileName) {
          if (!originalFileName.match(/\.[^.]*$/)) {
            finalFileName = originalFileName + ext;
          } else {
            finalFileName = originalFileName;
          }
        } else {
          finalFileName = `${folderName}${ext}`;
        }
        finalFileName = finalFileName.replace(/[()]/g, '');
        const finalPath = path.join(postDir, finalFileName);
        fs.renameSync(tempPath, finalPath);
        console.log(`   ✅ Saved as: ${finalFileName}`);
      }
    } catch (err) {
      console.error(`   ❌ Download error: ${err.message}`);
    }
  } else {
    console.log(`⚠️ No media in this post`);
  }
  console.log(`📁 Saved to: ${postDir}`);
  return postDir;
}

async function main() {
  let client = null;
  const downloadedDirs = [];
  try {
    console.log('🚀 Connecting to Telegram API...');
    console.log(`📌 Total posts to download: ${postUrls.length}`);
    console.log(`📌 URLs: ${postUrls.join(', ')}\n`);
    const session = new StringSession(stringSession);
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      useWSS: true,
    });
    await client.start({
      phoneNumber: () => { throw new Error('Use STRING_SESSION'); },
      phoneCode: () => { throw new Error('Use STRING_SESSION'); },
      password: () => { throw new Error('Use STRING_SESSION'); },
    });
    console.log('✅ Connected!\n');
    for (let i = 0; i < postUrls.length; i++) {
      console.log(`\n📥 [${i+1}/${postUrls.length}] Downloading...`);
      const postDir = await downloadPost(client, postUrls[i]);
      downloadedDirs.push(postDir);
    }
    fs.writeFileSync('/tmp/all_post_dirs.txt', downloadedDirs.join('\n') + '\n');
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ All downloads completed! (${downloadedDirs.length} posts)`);
    console.log(`${'='.repeat(50)}`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (client) await client.disconnect();
  }
}

main();
