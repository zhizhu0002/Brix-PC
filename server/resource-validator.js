const fs = require('fs');
const path = require('path');

const PACK_FORMAT_VERSION_MAP = {
    '1.14': 4, '1.14.1': 4, '1.14.2': 4, '1.14.3': 4, '1.14.4': 4,
    '1.15': 5, '1.15.1': 5, '1.15.2': 5,
    '1.16': 6, '1.16.1': 6, '1.16.2': 6, '1.16.3': 6, '1.16.4': 6, '1.16.5': 6,
    '1.17': 7, '1.17.1': 7,
    '1.18': 8, '1.18.1': 8, '1.18.2': 8,
    '1.19': 9, '1.19.1': 9, '1.19.2': 9, '1.19.3': 11, '1.19.4': 12,
    '1.20': 15, '1.20.1': 15, '1.20.2': 16, '1.20.3': 17, '1.20.4': 18, '1.20.5': 19, '1.20.6': 19, '1.20.7': 20,
    '1.21': 21, '1.21.1': 21,
};

function parseMcVersion(versionStr) {
    const match = versionStr.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3] || 0) };
}

function getPackFormatForVersion(versionStr) {
    const version = parseMcVersion(versionStr);
    if (!version) return null;
    
    const verKey = `${version.major}.${version.minor}`;
    if (PACK_FORMAT_VERSION_MAP[verKey]) {
        return PACK_FORMAT_VERSION_MAP[verKey];
    }
    
    const verKeyFull = `${version.major}.${version.minor}.${version.patch}`;
    if (PACK_FORMAT_VERSION_MAP[verKeyFull]) {
        return PACK_FORMAT_VERSION_MAP[verKeyFull];
    }
    
    let latestFormat = 0;
    for (const [key, format] of Object.entries(PACK_FORMAT_VERSION_MAP)) {
        const keyVer = parseMcVersion(key);
        if (keyVer && keyVer.major <= version.major && keyVer.minor <= version.minor) {
            latestFormat = Math.max(latestFormat, format);
        }
    }
    return latestFormat > 0 ? latestFormat : null;
}

function validatePackMcmeta(packMcmetaPath, packType) {
    const errors = [];
    const warnings = [];
    let metadata = {};
    
    if (!fs.existsSync(packMcmetaPath)) {
        errors.push(`缺少 ${packType} 必需文件: pack.mcmeta`);
        return { valid: false, errors, warnings, metadata };
    }
    
    let content;
    try {
        content = fs.readFileSync(packMcmetaPath, 'utf8');
    } catch (e) {
        errors.push(`无法读取 pack.mcmeta: ${e.message}`);
        return { valid: false, errors, warnings, metadata };
    }
    
    try {
        metadata = JSON.parse(content);
    } catch (e) {
        errors.push(`pack.mcmeta JSON 解析失败: ${e.message}`);
        return { valid: false, errors, warnings, metadata };
    }
    
    if (!metadata.pack) {
        errors.push('pack.mcmeta 缺少 pack 字段');
        return { valid: false, errors, warnings, metadata };
    }
    
    const pack = metadata.pack;
    
    if (typeof pack.pack_format !== 'number') {
        errors.push('pack.mcmeta pack.pack_format 必须是数字');
    } else {
        const validFormats = Object.values(PACK_FORMAT_VERSION_MAP);
        if (!validFormats.includes(pack.pack_format)) {
            warnings.push(`pack_format ${pack.pack_format} 不是标准格式版本，可能与某些 Minecraft 版本不兼容`);
        }
    }
    
    if (typeof pack.description !== 'string') {
        warnings.push('pack.mcmeta pack.description 建议为字符串类型');
    }
    
    if (packType === 'resourcepack') {
        if (!metadata.texture) {
            warnings.push('材质包建议包含 texture 字段配置');
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        metadata,
        packFormat: pack.pack_format,
        description: pack.description || ''
    };
}

function validateDatapack(datapackPath) {
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(datapackPath)) {
        errors.push('数据包路径不存在');
        return { valid: false, errors, warnings, type: 'datapack' };
    }
    
    const stat = fs.statSync(datapackPath);
    const isDir = stat.isDirectory();
    
    if (!isDir && !datapackPath.toLowerCase().endsWith('.zip')) {
        errors.push('数据包必须是文件夹或 .zip 文件');
        return { valid: false, errors, warnings, type: 'datapack' };
    }
    
    let packMcmetaPath;
    if (isDir) {
        packMcmetaPath = path.join(datapackPath, 'pack.mcmeta');
    }
    
    let validationResult = { valid: false, errors: [], warnings: [], metadata: {}, packFormat: null, description: '' };
    
    if (isDir) {
        validationResult = validatePackMcmeta(packMcmetaPath, '数据包');
        errors.push(...validationResult.errors);
        warnings.push(...validationResult.warnings);
        
        const dataDir = path.join(datapackPath, 'data');
        if (!fs.existsSync(dataDir)) {
            warnings.push('数据包缺少 data 目录，可能是一个空数据包');
        } else {
            const namespaces = fs.readdirSync(dataDir).filter(f => !f.startsWith('.'));
            if (namespaces.length === 0) {
                warnings.push('数据包 data 目录为空，没有命名空间');
            }
        }
        
        const packIconPath = path.join(datapackPath, 'pack.png');
        if (!fs.existsSync(packIconPath)) {
            warnings.push('数据包缺少 pack.png 图标文件');
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        type: 'datapack',
        isDirectory: isDir,
        packFormat: validationResult.packFormat,
        description: validationResult.description,
        size: stat.size
    };
}

function validateResourcepack(resourcepackPath) {
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(resourcepackPath)) {
        errors.push('材质包路径不存在');
        return { valid: false, errors, warnings, type: 'resourcepack' };
    }
    
    const stat = fs.statSync(resourcepackPath);
    const isDir = stat.isDirectory();
    
    if (!isDir && !resourcepackPath.toLowerCase().endsWith('.zip')) {
        errors.push('材质包必须是文件夹或 .zip 文件');
        return { valid: false, errors, warnings, type: 'resourcepack' };
    }
    
    let packMcmetaPath;
    if (isDir) {
        packMcmetaPath = path.join(resourcepackPath, 'pack.mcmeta');
    }
    
    let validationResult = { valid: false, errors: [], warnings: [], metadata: {}, packFormat: null, description: '' };
    
    if (isDir) {
        validationResult = validatePackMcmeta(packMcmetaPath, '材质包');
        errors.push(...validationResult.errors);
        warnings.push(...validationResult.warnings);
        
        const assetsDir = path.join(resourcepackPath, 'assets');
        if (!fs.existsSync(assetsDir)) {
            warnings.push('材质包缺少 assets 目录，可能是一个空材质包');
        } else {
            const namespaces = fs.readdirSync(assetsDir).filter(f => !f.startsWith('.'));
            if (namespaces.length === 0) {
                warnings.push('材质包 assets 目录为空，没有命名空间');
            }
        }
        
        const packIconPath = path.join(resourcepackPath, 'pack.png');
        if (!fs.existsSync(packIconPath)) {
            warnings.push('材质包缺少 pack.png 图标文件');
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        type: 'resourcepack',
        isDirectory: isDir,
        packFormat: validationResult.packFormat,
        description: validationResult.description,
        size: stat.size
    };
}

function validateShaderpack(shaderpackPath) {
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(shaderpackPath)) {
        errors.push('光影包路径不存在');
        return { valid: false, errors, warnings, type: 'shaderpack' };
    }
    
    const stat = fs.statSync(shaderpackPath);
    const isDir = stat.isDirectory();
    
    if (!isDir && !shaderpackPath.toLowerCase().endsWith('.zip')) {
        errors.push('光影包必须是文件夹或 .zip 文件');
        return { valid: false, errors, warnings, type: 'shaderpack' };
    }
    
    let packMcmetaPath;
    let shadersDir;
    let shaderPropsPath;
    
    if (isDir) {
        packMcmetaPath = path.join(shaderpackPath, 'pack.mcmeta');
        shadersDir = path.join(shaderpackPath, 'shaders');
        shaderPropsPath = path.join(shaderpackPath, 'shaders.properties');
    }
    
    let validationResult = { valid: false, errors: [], warnings: [], metadata: {}, packFormat: null, description: '' };
    
    if (isDir) {
        if (packMcmetaPath) {
            validationResult = validatePackMcmeta(packMcmetaPath, '光影包');
            errors.push(...validationResult.errors);
            warnings.push(...validationResult.warnings);
        } else {
            warnings.push('光影包缺少 pack.mcmeta 文件（可选）');
        }
        
        if (!fs.existsSync(shadersDir)) {
            errors.push('光影包缺少 shaders 目录');
        } else {
            const shaderFiles = fs.readdirSync(shadersDir).filter(f => !f.startsWith('.') && (f.endsWith('.vsh') || f.endsWith('.fsh') || f.endsWith('.glsl') || f.endsWith('.json')));
            if (shaderFiles.length === 0) {
                warnings.push('光影包 shaders 目录为空或没有 shader 文件');
            }
        }
        
        if (!fs.existsSync(shaderPropsPath)) {
            warnings.push('光影包缺少 shaders.properties 配置文件');
        }
        
        const packIconPath = path.join(shaderpackPath, 'pack.png');
        if (!fs.existsSync(packIconPath)) {
            warnings.push('光影包缺少 pack.png 图标文件');
        }
        
        const optionsDir = path.join(shaderpackPath, 'options');
        if (!fs.existsSync(optionsDir)) {
            warnings.push('光影包缺少 options 目录（用于着色器选项配置）');
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        type: 'shaderpack',
        isDirectory: isDir,
        packFormat: validationResult.packFormat,
        description: validationResult.description,
        size: stat.size
    };
}

function validateMod(jarPath) {
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(jarPath)) {
        errors.push('模组文件不存在');
        return { valid: false, errors, warnings, type: 'mod' };
    }
    
    const stat = fs.statSync(jarPath);
    if (!stat.isFile()) {
        errors.push('模组必须是文件');
        return { valid: false, errors, warnings, type: 'mod' };
    }
    
    if (!jarPath.toLowerCase().endsWith('.jar')) {
        warnings.push('模组文件建议使用 .jar 扩展名');
    }
    
    if (stat.size === 0) {
        errors.push('模组文件为空');
        return { valid: false, errors, warnings, type: 'mod' };
    }
    
    if (stat.size < 100) {
        warnings.push('模组文件过小，可能不完整');
    }
    
    const fd = fs.openSync(jarPath, 'r');
    const magicBuf = Buffer.alloc(4);
    fs.readSync(fd, magicBuf, 0, 4, 0);
    fs.closeSync(fd);
    
    if (magicBuf[0] !== 0x50 || magicBuf[1] !== 0x4B) {
        errors.push('模组文件不是有效的 JAR/ZIP 格式');
        return { valid: false, errors, warnings, type: 'mod' };
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        type: 'mod',
        size: stat.size
    };
}

function validateModpack(modpackPath) {
    const errors = [];
    const warnings = [];
    
    if (!fs.existsSync(modpackPath)) {
        errors.push('整合包路径不存在');
        return { valid: false, errors, warnings, type: 'modpack' };
    }
    
    const stat = fs.statSync(modpackPath);
    
    if (!stat.isFile()) {
        errors.push('整合包必须是文件');
        return { valid: false, errors, warnings, type: 'modpack' };
    }
    
    const ext = path.extname(modpackPath).toLowerCase();
    const supportedExts = ['.mrpack', '.zip', '.modpack'];
    
    if (!supportedExts.includes(ext)) {
        warnings.push(`整合包文件扩展名 ${ext} 不是标准格式，建议使用 .mrpack 或 .zip`);
    }
    
    if (stat.size === 0) {
        errors.push('整合包文件为空');
        return { valid: false, errors, warnings, type: 'modpack' };
    }
    
    if (stat.size < 1024) {
        errors.push('整合包文件过小（小于1KB），可能下载不完整');
        return { valid: false, errors, warnings, type: 'modpack' };
    }
    
    const fd = fs.openSync(modpackPath, 'r');
    const magicBuf = Buffer.alloc(4);
    fs.readSync(fd, magicBuf, 0, 4, 0);
    fs.closeSync(fd);
    
    if (magicBuf[0] !== 0x50 || magicBuf[1] !== 0x4B) {
        errors.push('整合包文件不是有效的 ZIP 格式');
        return { valid: false, errors, warnings, type: 'modpack' };
    }
    
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        type: 'modpack',
        size: stat.size,
        extension: ext
    };
}

function validateResource(resourcePath, resourceType) {
    switch (resourceType.toLowerCase()) {
        case 'datapack':
            return validateDatapack(resourcePath);
        case 'resourcepack':
            return validateResourcepack(resourcePath);
        case 'shader':
        case 'shaderpack':
            return validateShaderpack(resourcePath);
        case 'mod':
            return validateMod(resourcePath);
        case 'modpack':
            return validateModpack(resourcePath);
        default:
            return { valid: false, errors: [`未知的资源类型: ${resourceType}`], warnings: [], type: resourceType };
    }
}

module.exports = {
    validateDatapack,
    validateResourcepack,
    validateShaderpack,
    validateMod,
    validateModpack,
    validateResource,
    validatePackMcmeta,
    getPackFormatForVersion,
    parseMcVersion
};