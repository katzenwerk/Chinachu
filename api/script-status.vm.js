var currentConfig = JSON.parse(fs.readFileSync(define.CONFIG_FILE, 'utf8'));
response.head(200);
response.end(JSON.stringify(Object.assign({}, data.status, {
	epgTitleHalfWidthEnabled: currentConfig.epgTitleHalfWidthEnabled === true
}), null, '  '));
