'use strict';

const net = require('net');
const os = require('os');

const privateIPv4Ranges = new net.BlockList();
privateIPv4Ranges.addSubnet('10.0.0.0', 8, 'ipv4');
privateIPv4Ranges.addSubnet('172.16.0.0', 12, 'ipv4');
privateIPv4Ranges.addSubnet('192.168.0.0', 16, 'ipv4');
privateIPv4Ranges.addSubnet('169.254.0.0', 16, 'ipv4');

function isSelectablePrivateIPv4(address) {
	return Boolean(
		address &&
		address.family === 'IPv4' &&
		address.internal === false &&
		net.isIPv4(address.address) &&
		privateIPv4Ranges.check(address.address, 'ipv4')
	);
}

function findPrivateIPv4Addresses(interfaces) {
	const addresses = [];

	Object.keys(interfaces).forEach(name => {
		interfaces[name]
			.filter(isSelectablePrivateIPv4)
			.forEach(address => addresses.push(address.address));
	});

	return addresses;
}

function resolveOpenServerHost(configuredHost, getNetworkInterfaces) {
	if (configuredHost) {
		return {
			host: configuredHost,
			autoDetected: false,
			addresses: []
		};
	}

	const interfaces = (getNetworkInterfaces || os.networkInterfaces)();
	const addresses = findPrivateIPv4Addresses(interfaces);

	if (addresses.length === 0) {
		throw new Error('No private IPv4 address was detected. Configure `wuiOpenHost` explicitly; the WUI Open Server was not started.');
	}

	return {
		host: addresses[0],
		autoDetected: true,
		addresses: addresses
	};
}

module.exports = {
	findPrivateIPv4Addresses: findPrivateIPv4Addresses,
	isSelectablePrivateIPv4: isSelectablePrivateIPv4,
	resolveOpenServerHost: resolveOpenServerHost
};
