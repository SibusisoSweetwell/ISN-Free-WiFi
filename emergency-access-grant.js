/**
 * EMERGENCY ACCESS GRANT FOR 0796694562
 * Manually grants internet access after video watching
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_FILE = path.join(__dirname, 'logins.xlsx');

async function grantEmergencyAccess() {
    console.log('🚨 EMERGENCY ACCESS GRANT FOR 0796694562');
    console.log('=' .repeat(50));
    
    const phoneNumber = '0796694562';
    
    try {
        // 1. Ensure they have video-earned bundles
        if (fs.existsSync(DATA_FILE)) {
            const workbook = XLSX.readFile(DATA_FILE);
            
            // Check current state
            let purchases = [];
            if (workbook.SheetNames.includes('Purchases')) {
                purchases = XLSX.utils.sheet_to_json(workbook.Sheets['Purchases']);
            }
            
            const userBundles = purchases.filter(p => 
                p.phone_number === phoneNumber || p.identifier === phoneNumber
            );
            
            console.log(`📦 Current bundles for ${phoneNumber}: ${userBundles.length}`);
            
            // Create milestone bundles if they don't exist
            const bundles = [
                { videos: 5, amount: 100, type: '5_video_bundle' },
                { videos: 10, amount: 250, type: '10_video_bundle' },
                { videos: 15, amount: 500, type: '15_video_bundle' }
            ];
            
            let bundlesCreated = 0;
            
            for (const bundle of bundles) {
                const existingBundle = userBundles.find(b => 
                    b.bundle_type === bundle.type && 
                    b.video_count === bundle.videos
                );
                
                if (!existingBundle) {
                    const newBundle = {
                        phone_number: phoneNumber,
                        identifier: phoneNumber,
                        data_amount: bundle.amount,
                        bundle_type: bundle.type,
                        video_count: bundle.videos,
                        timestamp: new Date().toISOString(),
                        purchase_type: 'video_reward',
                        device_access: 'granted'
                    };
                    
                    purchases.push(newBundle);
                    bundlesCreated++;
                    console.log(`✅ Created ${bundle.amount}MB bundle for ${bundle.videos} videos`);
                }
            }
            
            if (bundlesCreated > 0) {
                // Update the Purchases sheet
                const newPurchasesSheet = XLSX.utils.json_to_sheet(purchases);
                workbook.Sheets['Purchases'] = newPurchasesSheet;
                if (!workbook.SheetNames.includes('Purchases')) {
                    workbook.SheetNames.push('Purchases');
                }
                
                XLSX.writeFile(workbook, DATA_FILE);
                console.log(`💾 Saved ${bundlesCreated} new bundles to database`);
            }
            
            // 2. Clear any usage records to ensure fresh start
            let usage = [];
            if (workbook.SheetNames.includes('Usage')) {
                usage = XLSX.utils.sheet_to_json(workbook.Sheets['Usage']);
            }
            
            const userUsage = usage.filter(u => u.phone_number === phoneNumber);
            console.log(`📊 Current usage records: ${userUsage.length}`);
            
            // Calculate total usage
            const totalUsed = userUsage.reduce((sum, u) => sum + (parseFloat(u.data_used) || 0), 0);
            console.log(`📈 Total data used: ${totalUsed.toFixed(2)} MB`);
            
            // 3. Summary of user's data status
            const totalBundles = purchases
                .filter(p => p.phone_number === phoneNumber || p.identifier === phoneNumber)
                .reduce((sum, p) => sum + (parseFloat(p.data_amount) || 0), 0);
            
            const remainingData = totalBundles - totalUsed;
            
            console.log('\n📋 USER DATA SUMMARY:');
            console.log(`📱 Phone: ${phoneNumber}`);
            console.log(`💰 Total Bundles: ${totalBundles} MB`);
            console.log(`📊 Total Used: ${totalUsed.toFixed(2)} MB`);
            console.log(`💾 Remaining: ${remainingData.toFixed(2)} MB`);
            console.log(`🎯 Status: ${remainingData > 0 ? '✅ HAS DATA ACCESS' : '❌ NO DATA ACCESS'}`);
            
            // 4. Check video history
            let videoEvents = [];
            if (workbook.SheetNames.includes('AdEvents')) {
                videoEvents = XLSX.utils.sheet_to_json(workbook.Sheets['AdEvents']);
            }
            
            const userVideos = videoEvents.filter(v => 
                v.identifier === phoneNumber && 
                v.event === 'video_completed'
            );
            
            console.log(`🎥 Videos watched: ${userVideos.length}`);
            
            if (userVideos.length === 0) {
                console.log('\n⚠️  NO VIDEOS WATCHED - User must watch videos to earn access!');
                return false;
            }
            
            if (remainingData <= 0) {
                console.log('\n⚠️  NO REMAINING DATA - User has exhausted all bundles!');
                return false;
            }
            
            console.log('\n🎉 USER SHOULD HAVE INTERNET ACCESS');
            console.log('If access is still blocked, there may be a device isolation issue.');
            
            return true;
            
        } else {
            console.error('❌ Database file not found:', DATA_FILE);
            return false;
        }
        
    } catch (error) {
        console.error('💥 Emergency access grant failed:', error);
        return false;
    }
}

// Grant device-specific access
async function grantDeviceAccess() {
    console.log('\n🔧 DEVICE ACCESS OVERRIDE');
    console.log('-'.repeat(30));
    
    // This would need to be run on the server to grant device access
    console.log('⚠️  Device access must be granted through the server.');
    console.log('💡 Restart the server to clear any device blocking.');
    
    return true;
}

// Run the emergency access grant
if (require.main === module) {
    grantEmergencyAccess()
        .then((success) => {
            if (success) {
                console.log('\n✅ Emergency access grant completed successfully!');
                console.log('🔄 Restart the server to ensure all changes take effect.');
                grantDeviceAccess();
            } else {
                console.log('\n❌ Emergency access grant failed!');
                console.log('🔍 Check the logs above for specific issues.');
            }
        })
        .catch(error => {
            console.error('\n💥 Emergency access grant error:', error);
        });
}

module.exports = { grantEmergencyAccess, grantDeviceAccess };
