'use strict';

function resolveTarget(config) {
	const uid = config && config.uid;
	const gid = config && (typeof config.gid === 'string' || typeof config.gid === 'number')
		? config.gid
		: 'video';

	if (typeof uid !== 'string' && typeof uid !== 'number') {
		throw new Error("'uid' required in config.");
	}

	return { uid, gid };
}

function dropPrivileges(processObject, config) {
	if (processObject.platform === 'win32' || processObject.getuid() !== 0) {
		return false;
	}

	const target = resolveTarget(config);

	// initgroups must run while privileged. The configured primary group is also
	// retained even when it is not listed in the user's supplementary groups.
	processObject.initgroups(target.uid, target.gid);
	processObject.setgid(target.gid);
	processObject.setuid(target.uid);
	return true;
}

module.exports = {
	dropPrivileges,
	resolveTarget
};
