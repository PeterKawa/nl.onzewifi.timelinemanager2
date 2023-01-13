/*jshint esversion: 8 */
/*jslint node: true */
"use strict";


const Homey = require('homey');
const fetch = require('node-fetch');
const luxon = require('luxon');
const Logger = require('./captureLogs.js');

class App extends Homey.App {

	async onInit() {

		// Dank aan Robin de Gruijter, Logger (via aangepaste captureLogs.js) initialiseren
		if (!this.logger) this.logger = new Logger({ name: 'timelinemanager2', length: 500, homey: Homey.app });

		this.log('Timeline Manager²' + this.homey.__("app.app-start"));

		const _this = this;
		const cloudId = await this.homey.cloud.getHomeyId();

		var tokens;
		var credentials;
		tokens = this.homey.settings.get('tokens') || {};
		credentials = this.homey.settings.get('credentials') || {};

		// Bij afsluiten de logfile opslaan
		this.homey.on('unload', () => {
			this.log('Timeline Manager²' + this.homey.__("app.app-end"));
			this.logger.saveLogs();
		});

		// Geheugen waarschwing
		this.homey.on('memwarn', () => {
			this.log('Memory warning');
		});

		// CPU spike waarschuwing
		this.homey.on('cpuwarn', () => {
			this.log('CPU Warning');
		});

		// Melding als instellingen zijn bijgewerkt
		this.homey.settings.on('set', async args => {
			this.log(args.charAt(0).toUpperCase() + args.slice(1) + this.homey.__("app.settingsupdated"));
			tokens = this.homey.settings.get('tokens') || {};
			credentials = this.homey.settings.get('credentials') || {};
		});

		// Global Garbage Collection ieder 5 minuten
		this.intervalIdGc = setInterval(() => {
			global.gc();
		}, 300 * 1000 /*ms*/);

		if (credentials === null) {
			this.error(this.homey.__("app.nosettings"));
			await this.homey.notifications.createNotification({ excerpt: this.homey.__("app.nosettings") });
		} else {
			tokens = this.homey.settings.get('tokens');
			if (tokens === null) {
				this.error(this.homey.__("app.tokenfailed"));
				await this.homey.notifications.createNotification({ excerpt: this.homey.__("app.tokenfailed") });
			} else {
				let result = await this.refreshBearer(cloudId, credentials.client_id, credentials.client_secret, tokens.access_token);
				if (result.failed) {
					result = await this.refreshAccessToken(cloudId, credentials.client_id, credentials.client_secret, tokens.access_token, tokens.refresh_token);
				}
				if (result.failed) {
					result = await this.refreshAuthentication(cloudId, credentials.client_id, credentials.client_secret, credentials.username, credentials.password, '');
				}
				if (result.payload.code === 401) {
					this.error(this.homey.__("app.2faenabled"));
					await this.homey.notifications.createNotification({ excerpt: this.homey.__("app.2faenabled") });
				}
				if (result.failed) {
					this.error(this.homey.__("app.tokenfailed"));
					await this.homey.notifications.createNotification({ excerpt: this.homey.__("app.tokenfailed") });
				}
			}
		}

		// Ieder uur het access_token refreshen
		this.homey.setInterval(async () => {
			this.log("setInterval access_token");
			var credentials = this.homey.settings.get('credentials');
			var tokens = this.homey.settings.get('tokens');
			try {
				await this.refreshAccessToken(cloudId, credentials.client_id, credentials.client_secret, tokens.access_token, tokens.refresh_token);
				//this.log('Testing Api (access)')
				if (!(await this.testBearer(cloudId, tokens.bearer_token))) {
					this.error('refreshAccessToken failed');
				} else {
					//this.log('refreshAccessToken passed')
				}
			}
			catch (error) {
				this.error(error);
			}
		}, 3600 * 1000 /*ms*/);

		// Iedere 24 uur een nieuwe Bearer token opvragenn
		this.homey.setInterval(async () => {
			this.log("setInterval bearer_token");
			var credentials = this.homey.settings.get('credentials');
			var tokens = this.homey.settings.get('tokens');
			try {
				await this.refreshBearer(cloudId, credentials.client_id, credentials.client_secret, tokens.access_token);
				//this.log('Testing Api (bearer)')
				if (!(await this.testBearer(cloudId, tokens.bearer_token))) {
					this.error('refreshBearer failed');
				} else {
					//this.log('refreshBearer passed')
				}
			}
			catch (error) {
				this.error(error);
			}
		}, 84600 * 1000 /*ms*/);

		// Action Flowcard Selfdestruction Notification
		const create_self_desctruction_notification = this.homey.flow.getActionCard("create_self_desctruction_notification");
		create_self_desctruction_notification.registerRunListener(
			async (args) => {
				this.log("actionCard create_self_desctruction_notification");
				try {
					_this.log("Creating the timer for the create_self_desctruction_notification");
					var beforeCreateNotification = new Date().toISOString();
					let result = await this.homey.notifications.createNotification({ excerpt: args.message });
					var afterCreateNotification = new Date().toISOString();
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (fecthedNotifications[key].dateCreated > beforeCreateNotification &&
							fecthedNotifications[key].dateCreated < afterCreateNotification &&
							fecthedNotifications[key].excerpt === args.message &&
							fecthedNotifications[key].ownerUri === 'homey:app:nl.onzewifi.timelinemanager2') {
							_this.log("Deleting notification '" + fecthedNotifications[key].excerpt + "' in " + args.duration * args.unit + " seconds.");
							_this.homey.setTimeout(() => {
								_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
							}, args.duration * args.unit * 1000);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		// Action Flowcard Delete all notifications
		const delete_all = this.homey.flow.getActionCard("delete_all");
		delete_all.registerRunListener(
			async (args) => {
				this.log("actionCard delete_all");
				try {
					this.deleteNotificationById(tokens.bearer_token, cloudId, '');
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		// Action Flowcard Delete notifications by category
		const delete_by_category = this.homey.flow.getActionCard("delete_by_category");
		delete_by_category.registerArgumentAutocompleteListener(
			"category",
			async (query, args) => {
				this.log("AutocompleteListener delete_by_category");
				const results = await this.getNotificationCategories(tokens.bearer_token, cloudId);
				return results.filter((result) => {
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			}
		);
		delete_by_category.registerRunListener(
			async (args) => {
				this.log("actionCard delete_by_category {"+args.category.ownerid+"}");
				try {
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (fecthedNotifications[key].ownerUri === args.category.ownerid) {
							_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		// Action Flowcard Delete notifications containing
		const delete_by_containing = this.homey.flow.getActionCard("delete_by_containing");
		delete_by_containing.registerRunListener(
			async (args) => {
				this.log("actionCard delete_by_containing");
				try {
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (fecthedNotifications[key].excerpt.includes(args.message)) {
							_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		//  Action Flowcard Delete notifications older than
		const delete_by_age = this.homey.flow.getActionCard("delete_by_age");
		delete_by_age.registerRunListener(
			async (args) => {
				this.log("actionCard delete_by_age");
				try {
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (new Date(fecthedNotifications[key].dateCreated) < new Date() - args.duration * args.unit * 1000) {
							_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		// Action Flowcard Delete notifications by category older than
		const delete_by_category_age = this.homey.flow.getActionCard("delete_by_category_age");
		delete_by_category_age.registerArgumentAutocompleteListener(
			"category",
			async (query, args) => {
				this.log("AutocompleteListener delete_by_category_age");
				const results = await this.getNotificationCategories(tokens.bearer_token, cloudId);
				return results.filter((result) => {
					return result.name.toLowerCase().includes(query.toLowerCase());
				});
			}
		);
		delete_by_category_age.registerRunListener(
			async (args) => {
				this.log("actionCard delete_by_category_age{"+args.category.ownerid+"}");
				try {
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (fecthedNotifications[key].ownerUri === args.category.ownerid && new Date(fecthedNotifications[key].dateCreated) < new Date() - args.duration * args.unit * 1000) {
							_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);

		// Action Flowcard Delete notifications containing older than
		const delete_by_containing_by_age = this.homey.flow.getActionCard("delete_by_containing_by_age");
		delete_by_containing_by_age.registerRunListener(
			async (args) => {
				this.log("actionCard delete_by_containing_by_age");
				try {
					let fecthedNotifications = await this.getNotifications(tokens.bearer_token, cloudId);
					Object.keys(fecthedNotifications).forEach(function (key) {
						if (fecthedNotifications[key].excerpt.includes(args.message) && new Date(fecthedNotifications[key].dateCreated) < new Date() - args.duration * args.unit * 1000) {
							_this.deleteNotificationById(tokens.bearer_token, cloudId, fecthedNotifications[key].id);
						}
					});
					return Promise.resolve(true);
				} catch (error) {
					this.error(error);
					return Promise.resolve(false);
				}
			}
		);
	}

	async getNotificationCategories(bearer_token, cloudId) {
		this.log("function getNotificationCategories");
		let result;
		var categories = [];
		var category = {};
		var response = await fetch('https://' + cloudId + '.connect.athom.com/api/manager/notifications/owner', {
			headers: { 'Authorization': 'Bearer ' + bearer_token },
			method: 'GET'
		});
		result = await response.text();
		if (response.status === 200) {
			Object.entries(JSON.parse(result)).forEach(([key, value]) => {
				if ((value.uriObj.name !== undefined) && (value.uriObj.name !== "")) {
					category = { name: value.uriObj.name, ownerid: key };
				} else {
					category = { name: key, ownerid: key };
				}
				categories.push(category);
			});
		} else {
			this.log('Only default catecories loaded; did not receive a 200 on the getNotificationCategories');
			categories = [
				{ name: 'Family', ownerid: 'homey:manager:users' },
				{ name: 'Presence', ownerid: 'homey:manager:presence' },
				{ name: 'Flow', ownerid: 'homey:manager:flow' },
				{ name: 'Updates', ownerid: 'homey:manager:updates' },
				{ name: 'Apps', ownerid: 'homey:manager:apps' },
				{ name: 'Energy', ownerid: 'homey:manager:energy' },
				{ name: 'Zigbee', ownerid: 'homey:manager:zigbee' }
			];
		}
		return categories;
	}

	async deleteNotificationById(bearer_token, cloudId, Id) {
		this.log("function deleteNotificationById"+Id);
		var url = 'http://127.0.0.1/api/manager/notifications/notification/' + Id;
		let result;
		try {
			var response = await fetch(url, {
				headers: { 'Authorization': 'Bearer ' + bearer_token },
				method: 'DELETE'
			});
			result = await response;
		} catch (e) {
			this.error(e);
		}
		return result.status;
	}

	async getNotifications(bearer_token, cloudId) {
		this.log("function getNotifications");
		let result;
		try {
			var response = await fetch('https://' + cloudId + '.connect.athom.com/api/manager/notifications/notification', {
				headers: { 'Authorization': 'Bearer ' + bearer_token },
				method: 'GET'
			});
			result = await response.text();
		} catch (e) {
			this.error(e);
		}
		return JSON.parse(result);
	}

	async testCredentials(clientid, clientsecret, username, password, otptoken) {
		this.log("function testCredentials");
		var cloudId = await this.homey.cloud.getHomeyId();
		var result = await this.refreshAuthentication(cloudId, clientid, clientsecret, username, password, otptoken);
		if (result.failed) {
			return result;
		}
		result = await this.refreshBearer(cloudId, clientid, clientsecret, JSON.parse(result.payload).access_token);
		return result;
	}

	async testBearer(cloudId, bearerToken) {
		this.log("function testBearer");
		var response = await fetch('https://' + cloudId + '.connect.athom.com/api/manager/cloud/state/', {
			method: 'GET',
			headers: { 'Authorization': 'Bearer ' + bearerToken }
		});
		if (response.status === 200) {
			return true;
		}
		return false;
	}

	async refreshAuthentication(cloudId, client_id, client_secret, username, password, otptoken) {
		this.log("function refreshAuthentication");
		var redirect_url = 'http://localhost/oauth2/callback';
		var authurl = 'https://accounts.athom.com/login';
		var response = await fetch(authurl, {
			"headers": { "accept": "application/json, text/javascript, */*; q=0.01", "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
			"referrerPolicy": "no-referrer-when-downgrade",
			"body": 'email=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password) + '&otptoken=' + encodeURIComponent(otptoken),
			"credentials": "omit",
			"mode": "cors",
			"method": "POST"
		});
		var user_token = await response.text();
		if (response.status != 200) {
			response.failed = true;
			response.payload = user_token;
			this.error('refreshAuthentication (Authenticate): ' + response.payload);
			return response;
		}

		var usertoken = JSON.parse(user_token);
		var authorizeurl = 'https://accounts.athom.com/oauth2/authorise?client_id=' + client_id + '&redirect_uri=' + encodeURIComponent(redirect_url) + '&response_type=code&user_token=' + usertoken.token;
		response = await fetch(authorizeurl, {
			"headers": {},
			"credentials": "include",
			"mode": "cors",
			"method": "GET"
		});
		var cookie = await response.text();
		if (response.status != 200) {
			response.failed = true;
			response.payload = cookie;
			this.error('refreshAuthentication (User Token): ' + response.payload);
			return response;
		}

		const between = function (str, strf, strt) { return str.split(strf).pop().split(strt)[0].trim(); };
		var csrf = between(cookie, 'name="_csrf" value="', '">');
		var raw = response.headers.raw()['set-cookie'];
		var cookiecsrf;
		for (let cookie of raw) {
			if (cookie.startsWith('_csrf=')) {
				cookiecsrf = cookie.match(/=(.+?);/)[1];
				break;
			}
		}
		var cookie4 = '_csrf=' + cookiecsrf;
		authorizeurl = 'https://accounts.athom.com/authorise?client_id=' + client_id + '&redirect_uri=' + encodeURIComponent(redirect_url) + '&response_type=code&user_token=' + usertoken.token;
		response = await fetch(authorizeurl, {
			"headers": { "content-type": "application/x-www-form-urlencoded", "cookie": cookie4 },
			"redirect": "manual",
			"body": "resource=resource.homey." + cloudId + "&_csrf=" + csrf + "&allow=Allow",
			"credentials": "include",
			"mode": "cors",
			"method": "POST"
		});
		if (response.status != 302) {
			response.failed = true;
			response.payload = await response.text();
			this.error('refreshAuthentication (Cookie): ' + response.payload);
			return response;
		}

		var code = response.headers.get('location').split('=')[1];
		var tokenendpoint = 'https://api.athom.com/oauth2/token';
		response = await fetch(tokenendpoint, {
			"headers": { "content-type": "application/x-www-form-urlencoded" },
			"body": 'client_id=' + encodeURIComponent(client_id) + '&client_secret=' + encodeURIComponent(client_secret) + '&grant_type=authorization_code&code=' + encodeURIComponent(code),
			"credentials": "include",
			"mode": "cors",
			"method": "POST"
		});
		if (response.status != 200) {
			response.failed = true;
			response.payload = await response.text();
			this.error('refreshAuthentication (Access Token): ' + response.payload);
			return response;
		}
		response.failed = false;
		response.payload = await response.text();
		var tokens = this.homey.settings.get('tokens');
		if (tokens === null) {
			tokens = {};
		}
		tokens.access_token = JSON.parse(response.payload).access_token;
		tokens.refresh_token = JSON.parse(response.payload).refresh_token;
		await this.homey.settings.set('tokens', tokens);
		return response;
	}

	async refreshAccessToken(cloudId, client_id, client_secret, access_token, refresh_token) {
		this.log("function refreshAccessToken");
		var tokenendpoint = 'https://api.athom.com/oauth2/token';
		var response = await fetch(tokenendpoint, {
			"headers": { "content-type": "application/x-www-form-urlencoded" },
			"body": 'client_id=' + encodeURIComponent(client_id) + '&client_secret=' + encodeURIComponent(client_secret) + '&grant_type=refresh_token&refresh_token=' + refresh_token,
			"credentials": "include",
			"mode": "cors",
			"method": "POST"
		});
		if (response.status != 200) {
			response.failed = true;
			response.payload = await response.text();
			this.error('refreshAccessToken: ' + response.payload);
			return response;
		}
		response.failed = false;
		response.payload = await response.text();
		var tokens = this.homey.settings.get('tokens');
		if (tokens === null) {
			tokens = {};
		}
		tokens.access_token = JSON.parse(response.payload).access_token;
		tokens.refresh_token = JSON.parse(response.payload).refresh_token;
		await this.homey.settings.set('tokens', tokens);
		return response;
	}

	async refreshBearer(cloudId, client_id, client_secret, access_token) {
		this.log("function refreshBearer");
		var delegationEndpoint = 'https://api.athom.com/delegation/token?audience=homey';
		var response = await fetch(delegationEndpoint, {
			"headers": { "content-type": "application/x-www-form-urlencoded", "authorization": "Bearer " + access_token },
			"referrerPolicy": "no-referrer-when-downgrade",
			"body": "client_id=" + client_id + " &client_secret=" + client_secret + "&grant_type=refresh_token&refresh_token=" + access_token,
			"credentials": "include",
			"mode": "cors",
			"method": "POST"
		});
		if (response.status != 200) {
			response.failed = true;
			response.payload = await response.text();
			this.error('refreshBearer (Access Token): ' + response.payload);
			return response;
		}
		var token = await response.json();
		var endpoint = 'https://' + cloudId + '.connect.athom.com/api/manager/users/login';
		response = await fetch(endpoint, {
			"headers": { "content-type": "application/json" },
			"body": JSON.stringify({ "token": token }),
			"method": "POST"
		});
		if (response.status != 200) {
			response.failed = true;
			response.payload = await response.text();
			this.error('refreshBearer (Bearer Token): ' + response.payload);
			return response;
		}
		response.failed = false;
		response.payload = "{ \"bearer_token\" : \"" + JSON.parse(await response.text()) + "\" }";
		var tokens = this.homey.settings.get('tokens');
		tokens.bearer_token = JSON.parse(response.payload).bearer_token;
		this.homey.settings.set('tokens', tokens);
		return response;
	}

	log() {
		console.log.bind(this, luxon.DateTime.now().setZone(this.homey.clock.getTimezone()).toFormat('dd HH:mm:ss') + " [log]").apply(this, arguments);
	}

	error() {
		console.error.bind(this, luxon.DateTime.now().setZone(this.homey.clock.getTimezone()).toFormat('dd HH:mm:ss') + " [err]").apply(this, arguments);
	}

	deletelogs() {
		return this.logger.deleteLogs();
	}

	getlogs() {
		return this.logger.logArray;
	}
}

module.exports = App;