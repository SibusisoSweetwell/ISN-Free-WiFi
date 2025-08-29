const XLSX = require('xlsx');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'logins.xlsx');
const SHEET_ADEVENTS = 'AdEvents';

console.log('[EXCEL-UPDATE] Adding video completion data for user 0796694562...');

try {
    // Load or create workbook
    let wb;
    if (require('fs').existsSync(DATA_FILE)) {
        wb = XLSX.readFile(DATA_FILE);
        console.log('[EXCEL-UPDATE] Loaded existing logins.xlsx');
    } else {
        wb = XLSX.utils.book_new();
        console.log('[EXCEL-UPDATE] Created new workbook');
    }
    
    // Ensure AdEvents sheet exists
    if (!wb.Sheets[SHEET_ADEVENTS]) {
        const ws = XLSX.utils.json_to_sheet([]);
        XLSX.utils.book_append_sheet(wb, ws, SHEET_ADEVENTS);
        console.log('[EXCEL-UPDATE] Created AdEvents sheet');
    }
    
    // Get existing video events
    const videoViews = XLSX.utils.sheet_to_json(wb.Sheets[SHEET_ADEVENTS]);
    console.log(`[EXCEL-UPDATE] Found ${videoViews.length} existing video events`);
    
    // Remove any existing events for user 0796694562 to avoid duplicates
    const filteredViews = videoViews.filter(v => v.identifier !== '0796694562');
    console.log(`[EXCEL-UPDATE] Removed existing events for 0796694562`);
    
    // Add 5 video completion events for milestone
    const baseTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago
    const newVideoEvents = [];
    
    for (let i = 0; i < 5; i++) {
        newVideoEvents.push({
            identifier: '0796694562',
            deviceId: '031f0b64',
            adId: `milestone_video_${i + 1}`,
            eventType: 'view',
            completedAt: baseTime + (i * 60 * 1000), // 1 minute apart
            duration: 30,
            earnedMB: i === 4 ? 100 : 0, // 100MB earned on 5th video
            timestamp: new Date(baseTime + (i * 60 * 1000)).toISOString()
        });
    }
    
    // Combine all video events
    const allVideoEvents = [...filteredViews, ...newVideoEvents];
    
    // Update the sheet
    wb.Sheets[SHEET_ADEVENTS] = XLSX.utils.json_to_sheet(allVideoEvents);
    
    // Save the workbook
    XLSX.writeFile(wb, DATA_FILE);
    
    console.log(`[EXCEL-UPDATE] Successfully added 5 video completion events for user 0796694562`);
    console.log(`[EXCEL-UPDATE] Total video events in sheet: ${allVideoEvents.length}`);
    console.log(`[EXCEL-UPDATE] User should now have 100MB video bundle earned`);
    
    // Verify the data was written correctly
    const verifyWb = XLSX.readFile(DATA_FILE);
    const verifyEvents = XLSX.utils.sheet_to_json(verifyWb.Sheets[SHEET_ADEVENTS]);
    const userEvents = verifyEvents.filter(v => v.identifier === '0796694562');
    
    console.log(`[EXCEL-UPDATE] Verification: Found ${userEvents.length} events for user 0796694562`);
    userEvents.forEach((event, index) => {
        console.log(`[EXCEL-UPDATE] Event ${index + 1}: ${event.adId} completed at ${event.timestamp}`);
    });
    
} catch (error) {
    console.error('[EXCEL-UPDATE-ERROR]', error.message);
}

console.log('[EXCEL-UPDATE] Update complete!');
