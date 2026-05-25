const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = process.env.STRING_SESSION;
const postUrl = process.env.POST_URL;  // فقط یک لینک در هر اجرا

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"|?*\\/]/g, '_').replace(/\s+/g, '_');
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
        reject(new Error("Download failed or file empty"));
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function getFileNameFromMedia(media) {
  if (media.document && media.document.attributes) {
    for (const attr of media.document.attributes) {
      if (attr.className === 'DocumentAttributeFilename') {
        return sanitizeFilename(attr.fileName);
      }
    }
  }
  return null;
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
    throw new Error(`Message ${msgId} not found in ${channelName}`);
  }
  
  console.log(`✅ Channel: ${channelName}`);
  console.log(`✅ Message ID: ${msgId}`);
  
  const postDir = `/tmp/telegram_downloads/${channelName}/${msgId}`;
  fs.mkdirSync(postDir, { recursive: true });
  
  const downloadedFiles = [];
  
  // Save message text
  if (message.text && message.text.length > 0) {
    const textFile = path.join(postDir, 'message_text.txt');
    fs.writeFileSync(textFile, message.text);
    downloadedFiles.push(textFile);
    console.log(`📝 Saved text (${message.text.length} chars)`);
  }
  
  // Download media
  if (message.media) {
    console.log(`📥 Downloading media...`);
    
    let fileName = await getFileNameFromMedia(message.media);
    
    if (!fileName) {
      const mediaType = message.media.className;
      if (mediaType === 'MessageMediaPhoto') {
        fileName = `photo_${Date.now()}.jpg`;
      } else if (mediaType === 'MessageMediaDocument') {
        fileName = `document_${Date.now()}`;
      } else {
        fileName = `media_${Date.now()}`;
      }
    }
    
    const tempPath = path.join(postDir, 'temp_download');
    
    try {
      await downloadMediaFile(client, message.media, tempPath, fileName);
      
      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        const fileType = execSync(`file --mime-type -b "${tempPath}"`).toString().trim();
        const extMap = {
          'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
          'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
          'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
          'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
          'image/webp': '.webp',
          'application/pdf': '.pdf', 'application/zip': '.zip',
          'application/x-rar': '.rar', 'application/x-7z-compressed': '.7z'
        };
        const ext = extMap[fileType] || '';
        
        let finalFileName = fileName;
        if (!fileName.includes('.') && ext) {
          finalFileName = fileName + ext;
        }
        
        const finalPath = path.join(postDir, finalFileName);
        fs.renameSync(tempPath, finalPath);
        downloadedFiles.push(finalPath);
        console.log(`   ✅ Saved as: ${finalFileName}`);
      }
    } catch (err) {
      console.error(`   ❌ Download error: ${err.message}`);
    }
  } else {
    console.log(`⚠️ No media in this post`);
  }
  
  // Save post info
  const totalSize = downloadedFiles.reduce((sum, f) => {
    try { return sum + fs.statSync(f).size; } catch { return sum; }
  }, 0);
  
  const infoFile = path.join(postDir, 'post_info.json');
  fs.writeFileSync(infoFile, JSON.stringify({
    url: postUrl,
    channel: channelName,
    postId: msgId,
    date: message.date,
    files: downloadedFiles.map(f => path.basename(f)),
    totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
    hasMedia: !!message.media,
    hasText: !!(message.text && message.text.length > 0)
  }, null, 2));
  
  console.log(`📊 Summary: ${downloadedFiles.length} file(s), ${(totalSize/1024/1024).toFixed(2)}MB`);
  console.log(`📁 Saved to: ${postDir}`);
  
  return postDir;
}

async function main() {
  let client = null;
  
  try {
    console.log('🚀 Connecting to Telegram API...');
    
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
    
    const postDir = await downloadPost(client, postUrl);
    
    // Save the directory path
    fs.writeFileSync('/tmp/downloaded_post_dir.txt', postDir);
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Download completed!`);
    console.log(`${'='.repeat(50)}`);
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    if (client) await client.disconnect();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
