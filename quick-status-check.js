/**
 * QUICK STATUS CHECK FOR 0796694562
 * Checks current data status and fixes
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_FILE = path.join(__dirname, 'logins.xlsx');

function quickStatusCheck() {
    console.log('🔍 QUICK STATUS CHECK FOR 0796694562');
    console.log('=' .repeat(50));
    
    const phoneNumber = '0796694562';
    
    if (!fs.existsSync(DATA_FILE)) {
        console.error('❌ Database file not found!');
        return;
    }
    
    try {
        const workbook = XLSX.readFile(DATA_FILE);
        
        // Check bundles
        let purchases = [];
        if (workbook.SheetNames.includes('Purchases')) {
            purchases = XLSX.utils.sheet_to_json(workbook.Sheets['Purchases']);
        }
        
        const userBundles = purchases.filter(p => 
            p.phone_number === phoneNumber || p.identifier === phoneNumber
        );
        
        console.log(`📦 Total bundles: ${userBundles.length}`);
        
        let totalBundles = 0;
        userBundles.forEach(bundle => {
            const amount = parseFloat(bundle.data_amount) || 0;
            totalBundles += amount;
            console.log(`  - ${amount}MB (${bundle.bundle_type || bundle.purchase_type || 'unknown'})`);
        });
        
        // Check usage
        let usage = [];
        if (workbook.SheetNames.includes('Usage')) {
            usage = XLSX.utils.sheet_to_json(workbook.Sheets['Usage']);
        }
        
        const userUsage = usage.filter(u => u.phone_number === phoneNumber);
        const totalUsed = userUsage.reduce((sum, u) => sum + (parseFloat(u.data_used) || 0), 0);
        
        console.log(`📊 Total used: ${totalUsed.toFixed(2)} MB`);
        console.log(`💾 Remaining: ${(totalBundles - totalUsed).toFixed(2)} MB`);
        
        // Check videos
        let videos = [];
        if (workbook.SheetNames.includes('AdEvents')) {
            videos = XLSX.utils.sheet_to_json(workbook.Sheets['AdEvents']);
        }
        
        const userVideos = videos.filter(v => 
            v.identifier === phoneNumber && 
            (v.event === 'video_completed' || v.completedAt)
        );
        
        console.log(`🎥 Videos watched: ${userVideos.length}`);
        
        // Status determination
        const hasData = (totalBundles - totalUsed) > 0;
        const hasVideos = userVideos.length > 0;
        
        console.log('\n🎯 STATUS SUMMARY:');
        console.log(`Data Available: ${hasData ? '✅ YES' : '❌ NO'}`);
        console.log(`Videos Watched: ${hasVideos ? '✅ YES' : '❌ NO'}`);
        console.log(`Should Have Access: ${hasData && hasVideos ? '✅ YES' : '❌ NO'}`);
        
        if (hasData && hasVideos) {
            console.log('\n💡 User should have internet access.');
            console.log('   If blocked, check device isolation settings.');
        } else if (!hasVideos) {
            console.log('\n⚠️  User needs to watch videos to earn access.');
        } else if (!hasData) {
            console.log('\n⚠️  User has exhausted all data bundles.');
        }
        
    } catch (error) {
        console.error('❌ Status check failed:', error);
    }
}

// Run check
quickStatusCheck();
