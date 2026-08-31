#!/usr/bin/env node

/**
 * Image optimization script - resizes and compresses og:image
 * Requires: npm install sharp
 */

const fs = require('fs');
const path = require('path');

// Try to require sharp, install if needed
let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.log('Installing sharp...');
  require('child_process').execSync('npm install sharp', { stdio: 'inherit', cwd: __dirname });
  sharp = require('sharp');
}

const inputPath = path.join(__dirname, 'frontend', 'assets', 'wods-og-image.png');
const tempPath = path.join(__dirname, 'frontend', 'assets', 'wods-og-image-temp.png');

const inputSize = fs.statSync(inputPath).size / (1024 * 1024); // MB
console.log(`📸 Optimizing image...`);
console.log(`   Input: ${inputSize.toFixed(2)} MB (1536x1024)`);

sharp(inputPath)
  .resize(1200, 630, {
    fit: 'cover',
    position: 'center'
  })
  .png({ quality: 80, progressive: true })
  .toFile(tempPath, (err, info) => {
    if (err) {
      console.error('❌ Error optimizing image:', err);
      process.exit(1);
    }

    try {
      // Replace original with optimized version
      fs.unlinkSync(inputPath);
      fs.renameSync(tempPath, inputPath);

      const outputSize = info.size / (1024 * 1024); // MB
      const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1);

      console.log(`✅ Image optimized successfully!`);
      console.log(`   Output: ${outputSize.toFixed(2)} MB (${info.width}x${info.height})`);
      console.log(`   Reduction: ${reduction}% smaller`);
      console.log(`\n🎉 Image ready for Open Graph previews!`);
    } catch (err) {
      console.error('❌ Error replacing image:', err);
      process.exit(1);
    }
  });
