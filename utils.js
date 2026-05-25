const fs = require('fs');
const path = require('path');

function createReadme(folderPath, folderName, totalSizeMB, partsCount) {
  const readmePath = path.join(folderPath, 'README.md');
  const content = `# 📥 ${folderName}

**Size:** ${totalSizeMB} MB
**Parts:** ${partsCount}

## Download
Download all parts (.z01, .z02, ..., .zip) and extract the .zip file.

*Created by [avasam.ir](https://avasam.ir)*
`;
  fs.writeFileSync(readmePath, content);
  console.log(`  ✅ Created README.md for ${folderName}`);
}

function createSimpleReadme(folderPath, folderName, sizeMB) {
  const readmePath = path.join(folderPath, 'README.md');
  const content = `# 📥 ${folderName}

**Size:** ${sizeMB} MB

## Download
Download ${folderName}.zip and extract.

*Created by [avasam.ir](https://avasam.ir)*
`;
  fs.writeFileSync(readmePath, content);
  console.log(`  ✅ Created README.md for ${folderName}`);
}

module.exports = { createReadme, createSimpleReadme };
