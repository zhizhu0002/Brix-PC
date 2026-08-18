const path = require('path');

const fs = require('fs-extra');
const uuid = require('uuid-random');
const xdgTrashdir = require('xdg-trashdir');
const { procfs } = require('@stroncium/procfs');

const mountPointMap = new Map();
const trashPathsCache = new Map();

function pad(number) {
	return number < 10 ? '0' + number : number;
}

function getDeletionDate(date) {
	return date.getFullYear()
		+ '-' + pad(date.getMonth() + 1)
		+ '-' + pad(date.getDate())
		+ 'T' + pad(date.getHours())
		+ ':' + pad(date.getMinutes())
		+ ':' + pad(date.getSeconds())
}

function refreshMountPoints() {
	procfs.processMountinfo()
		.forEach((info) => {
			mountPointMap.set(info.devId, info.mountPoint);
		});
}

async function getDeviceTrashPaths(devId){
	let promise = trashPathsCache.get(devId);

	if (promise === undefined) {
		promise = (async () => {
			const trashPath = await xdgTrashdir(mountPointMap.get(devId));
			const paths = {
				filesPath: path.join(trashPath, 'files'),
				infoPath: path.join(trashPath, 'info'),
			};

			await fs.mkdir(paths.filesPath, { mode: 0o700, recursive: true });
			await fs.mkdir(paths.infoPath, { mode: 0o700, recursive: true });

			return paths;
		})();

		trashPathsCache.set(devId, promise);
	}

	return promise;
}

async function trashFile(filePath, trashPaths) {
	const name = uuid();

	const destination = path.join(trashPaths.filesPath, name);
	const trashInfoPath = path.join(trashPaths.infoPath, `${name}.trashinfo`);

	const trashInfoData = `[Trash Info]\nPath=${filePath.replace(/\s/g, '%20')}\nDeletionDate=${getDeletionDate(new Date())}`;

	await fs.writeFile(trashInfoPath, trashInfoData);
	await fs.move(filePath, destination);

	return {
		path: destination,
		info: trashInfoPath,
	};
};

async function trashFiles(paths) {
	refreshMountPoints();

	return await Promise.all(
		paths.map(async (filePath) => {
			const stats = await fs.lstat(filePath);
			const trashPaths = await getDeviceTrashPaths(stats.dev);

			return trashFile(filePath, trashPaths);
		}),
	);
}

module.exports.trash = trashFiles;
