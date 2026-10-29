'use strict';

const net = require('net');
const os = require('os');

const privateIPv4Ranges = new net.BlockList();
privateIPv4Ranges.addSubnet('10.0.0.0', 8, 'ipv4');
privateIPv4Ranges.addSubnet('172.16.0.0', 12, 'ipv4');
privateIPv4Ranges.addSubnet('192.168.0.0', 16, 'ipv4');
privateIPv4Ranges.addSubnet('169.254.0.0', 16, 'ipv4');

const localRemoteIPv4Ranges = new net.BlockList();
localRemoteIPv4Ranges.addSubnet('127.0.0.0', 8, 'ipv4');
localRemoteIPv4Ranges.addSubnet('10.0.0.0', 8, 'ipv4');
localRemoteIPv4Ranges.addSubnet('172.16.0.0', 12, 'ipv4');
localRemoteIPv4Ranges.addSubnet('192.168.0.0', 16, 'ipv4');
localRemoteIPv4Ranges.addSubnet('169.254.0.0', 16, 'ipv4');

const privateIPv6Ranges = new net.BlockList();
privateIPv6Ranges.addAddress('::1', 'ipv6');
privateIPv6Ranges.addSubnet('fc00::', 7, 'ipv6');
privateIPv6Ranges.addSubnet('fe80::', 10, 'ipv6');

function mappedIPv4Address(address) {
	const dotted = address.match(/^::ffff:(.+)$/i);
	if (dotted && net.isIPv4(dotted[1])) return dotted[1];

	const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!hexadecimal) return null;

	const high = parseInt(hexadecimal[1], 16);
	const low = parseInt(hexadecimal[2], 16);
	return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function normalizeRemoteAddress(address) {
	if (typeof address !== 'string' || address.length === 0) return null;

	let normalized = address;
	const zoneIndex = normalized.indexOf('%');
	if (zoneIndex !== -1) {
		if (normalized.indexOf('%', zoneIndex + 1) !== -1) return null;
		normalized = normalized.slice(0, zoneIndex);
	}

	const family = net.isIP(normalized);
	if (family === 0) return null;
	if (family === 6) {
		const mapped = mappedIPv4Address(normalized);
		if (mapped !== null) return { address: mapped, family: 'ipv4' };
	}

	return { address: normalized, family: family === 4 ? 'ipv4' : 'ipv6' };
}

function isLocalRemoteAddress(address) {
	const normalized = normalizeRemoteAddress(address);
	if (normalized === null) return false;
	if (normalized.family === 'ipv4') {
		return localRemoteIPv4Ranges.check(normalized.address, 'ipv4');
	}
	// Node.js BlockListは展開表記を含むIPv4-mapped IPv6もIPv4 subnetとして照合する。
	if (localRemoteIPv4Ranges.check(normalized.address, 'ipv6')) return true;
	return privateIPv6Ranges.check(normalized.address, 'ipv6');
}

function isGlobalAccessBlockEnabled(configuredValue) {
	return configuredValue !== false;
}

function isRemoteAddressAllowed(address, configuredValue) {
	if (!isGlobalAccessBlockEnabled(configuredValue)) return true;
	return isLocalRemoteAddress(address);
}

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
	isGlobalAccessBlockEnabled: isGlobalAccessBlockEnabled,
	isLocalRemoteAddress: isLocalRemoteAddress,
	isRemoteAddressAllowed: isRemoteAddressAllowed,
	isSelectablePrivateIPv4: isSelectablePrivateIPv4,
	normalizeRemoteAddress: normalizeRemoteAddress,
	resolveOpenServerHost: resolveOpenServerHost
};
