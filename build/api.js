module.exports = {
	async testCredentials({ homey, query }) {
		const result = await homey.app.testCredentials(query.client_id, query.client_secret, query.username, query.password, query.otptoken);
		if (!(result.failed)) {
			var credentials = {}			
			credentials.client_id		= query.client_id
			credentials.client_secret	= query.client_secret
			credentials.username		= query.username
			credentials.password		= query.password
			await homey.settings.set('credentials', credentials)
			
		}
		return result;
	},
	async getlogs({ homey }) {
		const result = await homey.app.getlogs();
		return result;
	},
	async deletelogs({ homey }) {
		const result = await homey.app.deletelogs();
		return result;
	}
};