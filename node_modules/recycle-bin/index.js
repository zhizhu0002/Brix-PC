const path = require('path');

const fs = require('fs-extra');
const globby = require('globby');
const isPathInside = require('is-path-inside');

async function trash(paths, options) {
	paths = [paths].flat().map(path => String(path));

	options = { glob: true, ...options };

	// TODO: Upgrading to latest `globby` version is blocked by https://github.com/mrmlnc/fast-glob/issues/110
	if (options.glob) {
		paths = await globby(paths, {
			expandDirectories: false,
			nodir: false,
			nonull: true,
		});
	}

	paths = await Promise.all(paths.map(async filePath => {
		if (paths.some(otherPath => isPathInside(filePath, otherPath))) {
			return;
		}

		try {
			await fs.lstat(filePath);
		} catch (error) {
			if (error.code === 'ENOENT') {
				return;
			}

			throw error;
		}

		return path.resolve(filePath);
	}));

	paths = paths.filter(isPath => isPath);

	if (paths.length === 0) {
		return;
	}

	if (process.platform === 'darwin' || process.platform === 'win32') {
		const module = require('bindings')('trash.node');

		const result = module.trash(paths.length, ...paths);
		if (!result) throw new Error('Trash failed');
	} else if (process.platform === 'linux') {
		return require('./linux.js').trash(paths);
	} else {
		throw new Error('Platform is not supported');
	}
}

module.exports = trash;
module.exports.default = trash;
