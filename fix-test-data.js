const XLSX = require('xlsx');
const crypto = require('crypto');
const fs = require('fs');

const DATA_FILE = './logins.xlsx';
const SHEET_ADEVENTS = 'AdEvents';

function loadWorkbook() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return XLSX.readFile(DATA_FILE);
    }
  } catch (error) {
    console.log('Creating new workbook...');
  }
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([]);
  XLSX.utils.book_append_sheet(wb, ws, 'Users');
  return wb;
}

function addTestVideoData() {
  const wb = loadWorkbook();
  
  // Ensure AdEvents sheet exists
  if (!wb.Sheets[SHEET_ADEVENTS]) {
    const ws = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
  }
  
  const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
  
  // Add test video views for sbusisosweetwell15@gmail.com
  const testUser = 'sbusisosweetwell15@gmail.com';
  const testDevice = 'c21f969bd3cef23'; // Device ID from logs
  
  // Add 3 video views (should give 150MB at 50MB per video)
  for (let i = 1; i <= 3; i++) {
    videoViews.push({
      id: crypto.randomUUID(),
      identifier: testUser,
      deviceId: testDevice,
      videoUrl: `https://sample-videos.com/test-video-${i}.mp4`,
      duration: 30,
      completedAt: new Date().toISOString(),
      routerId: '10.5.48.94',
      ipAddress: '10.5.48.94'
    });
  }
  
  // Write back to sheet
  const ws = XLSX.utils.json_to_sheet(videoViews);
  wb.Sheets[SHEET_ADEVENTS] = ws;
  
  XLSX.writeFile(wb, DATA_FILE);
  console.log(`Added 3 video views for ${testUser} on device ${testDevice}`);
  console.log(`This should grant 150MB (3 videos × 50MB each)`);
}

addTestVideoData();
