const { Client } = require('pg');
const settings = require('../settings/settings.json');

const connection = new Client({
	host: settings.sql.host,
	port: settings.sql.port,
	user: settings.sql.user,
	database: settings.sql.database,
	password: settings.sql.password,
});

connection.connect((err) => {
	if (err) {
		console.error(err);
	}
	else {
		console.log('connected to postgres db');
	}
});

function findOrAddUser(user) {
	// TODO: make this better with INSERT...ON CONFLICT
	return new Promise((resolve, reject) => {
		// SELECT user ID based on USERNAME
		const queryStr = 'SELECT id FROM users WHERE name = \'' + user + '\'';
		connection.query(queryStr, (err, results) => {
			if (err) {
				reject(err);
			}
			else {
				// IF USERNAME does not exist...
				if (results.rows.length === 0) {
					const queryStr = 'INSERT INTO users (name) VALUES ($1) RETURNING id';
					connection.query(queryStr, [user], (err, results) => {
						if (err) {
							reject(err);
						}
						else {
							resolve(results.rows[0].id);
						}
					});
				}
				else {
					resolve(results.rows[0].id);
				}
			}
		});
	});
}

function findOrAddItem(item) {
	return new Promise((resolve, reject) => {
		// SELECT user ID based on ITEMNAME
		const queryStr = 'SELECT id FROM items WHERE name = $1';
		connection.query(queryStr, [item])
			.then((results) => {
				if (results.rows.length === 0) {
					const queryStr = 'INSERT INTO items (name) VALUES ($1) RETURNING id';
					connection.query(queryStr, [item], (err, results) => {

						if (err) {
							reject(err);
						}
						else {
							resolve(results.rows[0].id);
						}
					});
				}
				else {
					resolve(results.rows[0].id);
				}
			})
			.catch((err) => {
				console.error(err);
			});

	});
}

// TODO: this function should not return duplicate items, just the item once with lowest price
function getWatches(callback) {
	const query =
        'SELECT watches.id AS watch_id, items.name AS item_name, user_id, users.name AS user_name, price, server, datetime as timestamp ' +
        'FROM items ' +
        'INNER JOIN watches ON watches.item_id = items.id ' +
        'INNER JOIN users ON watches.user_id = users.id WHERE active = true;';
	connection.query(query)
		.then((res) => {
			callback(res.rows);
		})
		.catch((err) => console.error(err));
}

async function addWatch(user, item, server, price, watchId) {
	// if already have watchId, simple update -- Do we use this? or the separate function
	if (watchId) {
		const queryStr = 'UPDATE watches SET active = true WHERE id = $1;';
		return await connection.query(queryStr, [watchId]);
	}

	// otherwise add each item individually...

	// convert price from 1k to 1000pp
	// -1 denotes no price filter
	// this also prevents user from entering a maximum price of 0
	const convertedPrice = !price ? -1 : Number(price) * 1000;

	return findOrAddUser(user)
		.then((results) => {
			const userId = results;
			return findOrAddItem(item)
				.then(async (results) => {
					const itemId = results;

					const queryStr = '' +
                    'UPDATE watches ' +
                    'SET user_id = $1, item_id = $2, price = $3, server = $4, active = TRUE, datetime = current_timestamp ' +
                    'WHERE user_id = $1 AND item_id = $2 AND server = $4 RETURNING watches.id';
					return await connection.query(queryStr, [userId, itemId, convertedPrice, server])
						.then(async (results) => {
							if (results.rowCount === 0) {
								const queryStr = '' +
                            'INSERT INTO watches (user_id, item_id, price, server, datetime, active) ' +
                            'VALUES ($1, $2, $3, $4, current_timestamp, true) RETURNING id';
								return await connection.query(queryStr, [userId, itemId, convertedPrice, server])
									.then(async (res) => {
										return await showWatchById(res.rows[0].id);
									});
							}
							// adding a watch should unsnooze it
							return await unsnooze('item', results.rows[0].id)
								.then(async (res) => {
									console.log('unsnooze res = ', res);
									return await showWatchById(results.rows[0].id);
								});
						})
						.catch((err) => {
							Promise.reject(err);
						});
				});
		});
}

async function endWatch(user, item, server, watchId) {
	if (watchId) {
		const queryStr = 'UPDATE watches SET active = false WHERE id = $1;';
		return await connection.query(queryStr, [watchId])
			.then(async (res) => {
				console.log('endwatch res', res);
				return await showWatchById(watchId);
			})
			.catch((err) => {
				Promise.reject(err);
			});

	}
	else {
		return await findOrAddUser(user)
			.then(async (userId) => {
				await findOrAddItem(item)
					.then(async (itemId) => {
						if (server) {
							const queryStr = 'UPDATE watches SET active = false WHERE user_id = $1 AND item_id = $2 AND server = $3;';
							return await connection.query(queryStr, [userId, itemId, server])
								.then((res) => {
									console.log('with server res ', res);
									return Promise.resolve(res);
								})
								.catch(console.error);
						}
						// no server supplied, delete both watches
						// TODO: could warn users if they have 2 watches under the same name, ambigious delete
						const queryStr = 'UPDATE watches SET active = false WHERE user_id = $1 AND item_id = $2;';
						return await connection.query(queryStr, [userId, itemId])
							.then((res) => {
								console.log('without server res ', res);

								return Promise.resolve(res);
							})
							.catch(console.error);
					});
			})
			.catch((err) => {
				Promise.reject(err);
			});
	}
}

async function endAllWatches(user) {
	return await findOrAddUser(user)
		.then(async (userId) => {
			const queryStr = 'UPDATE watches SET active = false WHERE user_id = $1';
			return await connection.query(queryStr, [userId]);
		})
		.catch((err) => {
			console.error(err);
		});
}

async function getIndividualWatch(watchId) {
	const queryStr = '' +
            'SELECT watches.id, items.name, price, server, datetime, expiration, ' +
            'CASE WHEN expiration IS NULL OR expiration < now() THEN FALSE ' +
            'WHEN expiration >= now() THEN TRUE END AS snoozed ' +
            'FROM watches ' +
            'INNER JOIN items ON items.id = item_id ' +
            'LEFT JOIN snooze_by_watch ON snooze_by_watch.watch_id = watches.id ' +
            'WHERE watches.id = $1 AND watches.active = true ' +
			'AND expiration IS NULL OR expiration > now();';
	return connection.query(queryStr, [watchId])
		.then((res) => {
			return Promise.resolve(res.rows);
		})
		.catch((err) => {
			return Promise.reject(err);
		});
}

async function showWatch(user, item) {
	return await findOrAddUser(user)
		.then((results) => {
			const userId = results;
			const pattern = '%'.concat(item).concat('%');
			const queryStr = '' +
            'SELECT watches.id, items.name, price, server, datetime, expiration, ' +
            'CASE WHEN expiration IS NULL OR expiration < now() THEN FALSE ' +
            'WHEN expiration >= now() THEN TRUE END AS snoozed ' +
            'FROM watches ' +
            'INNER JOIN items ON items.id = item_id ' +
            'LEFT JOIN snooze_by_watch ON snooze_by_watch.watch_id = watches.id ' +
            'WHERE watches.user_id = $1 AND items.name LIKE $2 AND watches.active = true';
			'AND expiration IS NULL OR expiration > now() ORDER BY items.name ASC;';
			return connection.query(queryStr, [userId, pattern])
				.then((res) => {
					return Promise.resolve(res.rows);
				});
		})
		.catch(console.error);
}

async function showWatchById(id) {
	// careful...this returns watchInfo if if watch is inactive!
	const queryStr = '' +
            'SELECT watches.id, items.name, price, server, active, datetime, expiration,' +
            'CASE WHEN snooze_by_watch.watch_id IS NULL THEN FALSE ' +
            'WHEN snooze_by_watch.watch_id IS NOT NULL THEN TRUE END AS snoozed ' +
            'FROM watches ' +
            'INNER JOIN items ON items.id = item_id ' +
            'LEFT JOIN snooze_by_watch ON snooze_by_watch.watch_id = watches.id ' +
            'WHERE watches.id = $1 ';
	'AND expiration IS NULL OR expiration > now() ORDER BY items.name ASC;';
	return connection.query(queryStr, [id])
		.then((res) => {
			return Promise.resolve(res.rows.length > 0 ? res.rows[0] : null);
		});
}


async function listWatches(user) {
	console.log('listWatches user ', user);
	return await findOrAddUser(user)
		.then(async (userId) => {
			console.log('uerId', userId);
			const queryStr = '' +
                'SELECT watches.id, items.name, price, server, datetime, snooze_by_watch.expiration, CASE ' +
                'WHEN snooze_by_watch.expiration IS NULL OR snooze_by_watch.expiration < now() THEN FALSE ' +
                'WHEN snooze_by_watch.expiration >= now() THEN TRUE ' +
                'END AS watch_snooze, ' +
                'snooze_by_user.expiration, CASE ' +
                'WHEN snooze_by_user.expiration IS NULL OR snooze_by_user.expiration < now() THEN FALSE ' +
                'WHEN snooze_by_user.expiration >= now() THEN TRUE ' +
                'END AS global_snooze ' +
                'FROM watches ' +
                'INNER JOIN items ON items.id = item_id ' +
                'LEFT JOIN snooze_by_watch ON watch_id = watches.id ' +
                'LEFT JOIN snooze_by_user ON snooze_by_user.user_id = watches.user_id ' +
                'WHERE watches.user_id = $1 AND watches.active = TRUE ' +
                'ORDER BY items.name;';
			return await connection.query(queryStr, [userId])
				.then((res) => {
					return Promise.resolve(res.rows);
				});
		})
		.catch((err) => {
			Promise.reject(err);
		});
}

async function extendWatch(watchId) {
	const queryStr = 'UPDATE watches SET datetime = current_timestamp, active = TRUE WHERE watches.id = $1';
	return await connection.query(queryStr, [watchId])
		.then(async (res) => {
			console.log('extendWatch res ', res);
			// extending watches should unsnooze them
			return await unsnooze('item', watchId)
				.catch(console.error);
		});
}

async function extendAllWatches(user) {
	const queryStr = '' +
        'UPDATE watches ' +
        'SET datetime = current_timestamp ' +
        'FROM users ' +
        'WHERE watches.user_id = users.id AND users.name = $1 AND active = true;';
	return await connection.query(queryStr, [user])
		.then(async (res) => {
			return await listWatches(user);
		})
		.catch(console.error);
}

function blockSeller(user, seller, server, watchId) {
	// no watchId, account based block
	if (watchId === undefined || watchId === null) {
		// add or find user
		findOrAddUser(user).then((userId) => {
			if (server) {
				const queryStr = 'INSERT INTO blocked_seller_by_user (seller, user_id, server) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING';
				connection.query(queryStr, [seller, userId, server]).catch(console.error);
			}
			else {
				// no server, so add blocks for both servers
				const queryStr = 'INSERT INTO blocked_seller_by_user (seller, user_id, server) VALUES ($1, $2, \'GREEN\'), ($1, $2, \'BLUE\') ON CONFLICT DO NOTHING';
				connection.query(queryStr, [seller, userId]).catch(console.error);
			}
		}).catch(console.error);
	}
	else {
		// if watchId provided, block based on watch
		const queryStr = 'INSERT INTO blocked_seller_by_watch (seller, watch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING';
		connection.query(queryStr, [seller.toUpperCase(), watchId]).catch(console.error);
	}
}

function unblockSeller(user, seller, server, watchId) {
	findOrAddUser(user).then((userId) => {
		// if watchId provided, unblock based on watch
		if (watchId !== undefined && watchId !== null) {
			const queryStr = 'DELETE FROM blocked_seller_by_watch WHERE seller = $1 AND watch_id = $2;';
			connection.query(queryStr, [seller, watchId]).catch(console.error);
		}
		else {
			// otherwise, unblock account wide
			if (server) {
				const queryStr = 'DELETE FROM blocked_seller_by_user WHERE seller = $1 AND user_id = $2 AND server = $3;';
				connection.query(queryStr, [seller, userId, server]).then(() => {
					// also delete any instances of seller + server + user on watch based table
					const queryStr = 'DELETE FROM blocked_seller_by_watch WHERE watch_id IN (SELECT id FROM watches WHERE user_id = $1) AND seller = $2 AND server = $3';
					connection.query(queryStr, [userId, seller, server]);
				});
			}
			else {
				const queryStr = 'DELETE FROM blocked_seller_by_user WHERE seller = $1 AND user_id = $2;';
				connection.query(queryStr, [seller, userId]).then(() => {
					// also delete any instances of seller + user on watch based table
					const queryStr = 'DELETE FROM blocked_seller_by_watch WHERE watch_id IN (SELECT id FROM watches WHERE user_id = $1) AND seller = $2';
					connection.query(queryStr, [userId, seller]);
				});
			}
		}
	}).catch(console.error);
}

function showBlocks(user, callback) {
	return findOrAddUser(user)
		.then((userId) => {
			const queryStr = 'SELECT seller, server FROM blocked_seller_by_user WHERE user_id = $1';
			connection.query(queryStr, [userId]).then((user_blocks) => {
				const queryStr = 'SELECT seller, server, items.name, watches.server as item_server FROM blocked_seller_by_watch INNER JOIN watches ON blocked_seller_by_watch.watch_id = watches.id INNER JOIN items ON items.id = watches.item_id WHERE user_id = $1';
				connection.query(queryStr, [userId]).then((watch_blocks) => {
					callback({ user_blocks: user_blocks.rows, watch_blocks: watch_blocks.rows });
				});
			});
		}).catch(console.error);
}

async function snooze(type, id, hours = 6) {
	console.log('id = ', id);
	switch(type.toUpperCase()) {
	case 'ITEM':
		// insert into watch snoooze
		return (async () => {
			const queryStr = 'INSERT INTO snooze_by_watch (watch_id, expiration) VALUES ($1, now() + interval \'1 second\' * $2) ON CONFLICT (watch_id) DO UPDATE SET expiration = now() + interval \'1 second\' * $2;';
			return await connection.query(queryStr, [id, hours * 60 * 60])
				.then(async (res) => {
					return await showWatchById(id);
				})
				.catch(console.error);
		})();
	case 'GLOBAL':
		return findOrAddUser(id)
			.then((userId) => {
				// insert into account snooze
				return (async () => {
					const queryStr = 'INSERT INTO snooze_by_user (user_id, expiration) VALUES ($1, now() + interval \'1 hour\' * $2) ON CONFLICT (user_id) DO UPDATE SET expiration = now() + interval \'1 hour\' * $2;';
					return await connection.query(queryStr, [userId, hours])
						.then(async (res) => {
							console.log('db global snooze = ', res);
							return await listWatches(id);
						})
						.catch(console.error);
				})();
			})
			.catch(console.error);
	}
}

async function unsnooze(type, id) {
	switch(type.toUpperCase()) {
	case 'ITEM':
		return (async () => {
			const queryStr = 'DELETE FROM snooze_by_watch WHERE watch_id = $1;';
			return await connection.query(queryStr, [id])
				.then(async (res) => {
					return await showWatchById(id);
				})
				.catch(console.error);
		})();
	case 'GLOBAL':
		return findOrAddUser(id).then((userId) => {
			return (async () => {
				const queryStr = 'DELETE FROM snooze_by_user WHERE user_id = $1;';
				return await connection.query(queryStr, [userId])
					.then(async (res) => {
						return await listWatches(id);
					})
					.catch(console.error);
			})();
		});
	}
}

async function postSuccessfulCommunication(watchId, seller) {
	const queryStr = 'INSERT INTO communication_history (watch_id, seller, timestamp) VALUES ($1, $2, now()) ON CONFLICT ON CONSTRAINT communication_history_watch_id_seller_key DO UPDATE SET timestamp = now();';
	await connection.query(queryStr, [watchId, seller.toUpperCase()]).catch(console.error);
}


async function validateWatchNotification(userId, watchId, seller) {
	// check communication history to see if notified in the past 15 minutes
	const queryStr = 'SELECT id FROM communication_history WHERE watch_id = $1 AND seller = $2 AND timestamp > now() - interval \'15 minutes\';';
	const isValid = await connection.query(queryStr, [watchId, seller.toUpperCase()])
		.then((res) => {
			// notified within 15 minute window already, return false
			if (res.rows && res.rows.length > 0) {
				return false;
			}
			else {
				// otherwise check if seller is blocked by user
				const queryStr = 'SELECT seller FROM blocked_seller_by_user WHERE user_id = $1 AND seller = $2';
				return connection.query(queryStr, [userId, seller.toUpperCase()])
					.then((res) => {
						if (res && res.rows.length > 0) {
							// return false if seller is blocked by user
							return false;
						}
						else {
							// otherwise check if seller is blocked by watch
							const queryStr = 'SELECT seller FROM blocked_seller_by_watch WHERE watch_id = $1 AND seller = $2';
							return connection.query(queryStr, [watchId, seller.toUpperCase()])
								.then((res) => {
									if (res && res.rows.length > 0) {
										return false;
									}
									else {
										// otherwise check if watch is snoozed
										const queryStr = 'SELECT id FROM snooze_by_watch WHERE watch_id = $1 AND expiration > now()';
										return connection.query(queryStr, [watchId])
											.then((res) => {
												if (res && res.rows.length > 0) {
													return false;
												}
												else {
													// otherwise check if user is snoozed
													const queryStr = 'SELECT id FROM snooze_by_user WHERE user_id = $1 AND expiration > now()';
													return connection.query(queryStr, [userId])
														.then((res) => {
															if (res && res.rows.length > 0) {
																return false;
															}
															else {
																// if no results for any of these queries, it's safe to notify the user
																return true;
															}
														});
												}
											});
									}
								});
						}
					});
			}
		})
		.catch(console.error);
	return isValid;
}

function upkeep() {
	const query = 'UPDATE watches SET active = false WHERE datetime < now() - interval \'7 days\';';
	connection.query(query)
		.then((res) => {
			// TODO: pipe this to a private health_status channel on discord on devs have access to - write a log for every watch notification, command entry, etc.
			// console.log('Upkeep completed. Removed ', res.rowCount, ' old watches.')
		})
		.catch(console.error);
}

module.exports = { addWatch, endWatch, endAllWatches, extendWatch, extendAllWatches, showWatch, showWatchById, listWatches, snooze, unsnooze, getWatches, postSuccessfulCommunication, blockSeller, unblockSeller, showBlocks, validateWatchNotification, upkeep };