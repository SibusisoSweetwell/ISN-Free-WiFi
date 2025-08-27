console.log('Starting test server...');
try {
    const express = require('express');
    console.log('Express loaded successfully');
    
    const app = express();
    const PORT = 3000;
    
    app.get('/', (req, res) => {
        res.send('Test server working!');
    });
    
    app.listen(PORT, () => {
        console.log(`Test server running on port ${PORT}`);
    });
} catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
}
