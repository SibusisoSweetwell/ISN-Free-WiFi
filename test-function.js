const { getUsers } = require('./server.js');

// Test if getUsers function works
try {
  const users = getUsers();
  console.log('getUsers function works');
} catch (error) {
  console.error('getUsers error:', error.message);
}
