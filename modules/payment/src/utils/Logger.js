try {
	module.exports = require('../../../../utils/Logger.js');
} catch (err) {
	module.exports = {
		debugLog: null,
		writeLog: () => {},
	};
}
