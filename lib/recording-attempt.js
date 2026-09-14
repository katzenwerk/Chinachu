'use strict';

function start(program) {
	const attempt = {};

	Object.defineProperty(program, '_operatorPrepAttempt', {
		enumerable: false,
		configurable: true,
		value: attempt
	});

	return attempt;
}

function isCurrent(program, attempt) {
	return !!program && program._operatorPrepAttempt === attempt;
}

function clear(program, attempt) {
	if (!isCurrent(program, attempt)) {
		return false;
	}

	delete program._operatorPrepAttempt;
	return true;
}

function remove(recording, program, attempt) {
	if (!isCurrent(program, attempt)) {
		return false;
	}

	const index = recording.indexOf(program);
	if (index === -1) {
		clear(program, attempt);
		return false;
	}

	recording.splice(index, 1);
	clear(program, attempt);
	return true;
}

module.exports = {
	start,
	isCurrent,
	clear,
	remove
};
