/**
 * 图片上传
 */
import * as qiniu from "qiniu-js";
import {message} from "antd";
import axios from "axios";
import OSS from "ali-oss";
import imageHosting from "../store/imageHosting";

import {
  SM_MS_PROXY,
  ALIOSS_IMAGE_HOSTING,
  QINIUOSS_IMAGE_HOSTING,
  GITEE_IMAGE_HOSTING,
  GITHUB_IMAGE_HOSTING,
  IMAGE_HOSTING_TYPE,
  IS_CONTAIN_IMG_NAME,
  IMAGE_HOSTING_NAMES,
} from "./constant";
import {toBlob, getOSSName, axiosMdnice} from "./helper";

function showUploadNoti() {
  // 使用更安全的方式显示加载消息
  try {
    message.loading("图片上传中", 0);
  } catch (error) {
    console.error("显示上传通知失败:", error);
  }
}

function uploadError(description = "图片上传失败") {
  try {
    // 确保消息显示时间足够长，让用户能看到错误
    message.error(description, 3);
  } catch (error) {
    console.error("显示错误通知失败:", error);
    // 降级处理，尝试使用alert
    try {
      // 检查是否为服务不可用错误
      if (description.includes("Service is unavailable") || description === "服务不可用" || description.includes("network") || description.includes("Network")) {
        console.error("预览服务连接失败");
        // 使用更友好的错误提示
        message.error("预览服务暂时不可用，请稍后再试或检查网络连接", 5);
      } else {
        alert(description);
      }
    } catch (e) {
      console.error("显示alert失败:", e);
    }
  }
}

function hideUploadNoti() {
  try {
    // 先销毁所有消息，然后显示成功消息
    message.destroy();
    message.success("图片上传成功");
  } catch (error) {
    console.error("隐藏上传通知失败:", error);
  }
}

function writeToEditor({content, image}) {
  const isContainImgName = window.localStorage.getItem(IS_CONTAIN_IMG_NAME) === "true";
  console.log(isContainImgName);
  let text = "";
  if (isContainImgName) {
    text = `\n![${image.filename}](${image.url})\n`;
  } else {
    text = `\n![](${image.url})\n`;
  }
  const {markdownEditor} = content;
  const cursor = markdownEditor.getCursor();
  markdownEditor.replaceSelection(text, cursor);
  content.setContent(markdownEditor.getValue());
}

// 七牛云对象存储上传
export const qiniuOSSUpload = async ({
  file = {},
  onSuccess = () => {},
  onError = () => {},
  onProgress = () => {},
  images = [],
  content = null, // store content
}) => {
  showUploadNoti();
  let config;
  try {
    // 安全地获取和解析配置
    const configStr = window.localStorage.getItem(QINIUOSS_IMAGE_HOSTING);
    config = configStr ? JSON.parse(configStr) : {};
    
    // 检查配置是否完整
    if (!config || !config.accessKey || !config.secretKey || !config.bucket || !config.domain) {
      throw new Error("七牛云配置不完整，请检查配置");
    }
    let {domain} = config;
    const {namespace} = config;
    // domain可能配置时末尾没有加‘/’
    if (domain[domain.length - 1] !== "/") {
      domain += "/";
    }
    const result = await axiosMdnice.get(`/qiniu/${config.bucket}/${config.accessKey}/${config.secretKey}`);
    const token = result.data;

    const base64Reader = new FileReader();

    base64Reader.readAsDataURL(file);

    base64Reader.onload = (e) => {
      const urlData = e.target.result;
      const base64 = urlData.split(",").pop();
      const fileType = urlData
        .split(";")
        .shift()
        .split(":")
        .pop();

      // base64转blob
      const blob = toBlob(base64, fileType);

      const conf = {
        useCdnDomain: true,
        region: qiniu.region[config.region], // 区域
      };

      const putExtra = {
        fname: "",
        params: {},
        mimeType: [] || null,
      };

      const OSSName = getOSSName(file.name, namespace);

      // 这里第一个参数的形式是blob
      const imageObservable = qiniu.upload(blob, OSSName, token, putExtra, conf);

      // 上传成功后回调
      const complete = (response) => {
        // console.log(response);
        const names = file.name.split(".");
        names.pop();
        const filename = names.join(".");
        const image = {
          filename, // 名字不变并且去掉后缀
          url: encodeURI(`${domain}${response.key}`),
        };
        images.push(image);

        if (content) {
          writeToEditor({content, image});
        }
        onSuccess(response);
        setTimeout(() => {
          hideUploadNoti();
        }, 500);
      };

      // 上传过程回调
      const next = (response) => {
        // console.log(response);
        const percent = parseInt(Math.round(response.total.percent.toFixed(2)), 10);
        onProgress(
          {
            percent,
          },
          file,
        );
      };

      // 上传错误回调
      const error = (err) => {
        hideUploadNoti();
        uploadError();
        onError(err, err.toString());
      };

      const imageObserver = {
        next,
        error,
        complete,
      };
      // 注册 imageObserver 对象
      imageObservable.subscribe(imageObserver);
    };
  } catch (err) {
    console.error("七牛云上传错误:", err);
    hideUploadNoti();
    uploadError(err.message || "七牛云上传失败");
    onError(err, err.toString());
  }
};

// 用户自定义的图床上传
export const customImageUpload = async ({
  formData = new FormData(),
  file = {},
  onSuccess = () => {},
  onError = () => {},
  images = [],
  content = null,
}) => {
  showUploadNoti();
  try {
    // 检查文件是否有效
    if (!file || !file.name) {
      throw new Error('无效的文件');
    }
    
    // 检查图床URL是否配置
    if (!imageHosting || !imageHosting.hostingUrl) {
      throw new Error('请先配置图床URL');
    }
    
    // 创建新的FormData对象，避免重用可能已经被修改的formData
    const uploadFormData = new FormData();
    uploadFormData.append("file", file);
    
    const config = {
      headers: {
        "Content-Type": "multipart/form-data",
      },
      timeout: 30000 // 增加超时设置到30秒，避免大文件上传超时
    };
    
    const postURL = imageHosting.hostingUrl;
    console.log("开始上传到自定义图床:", postURL);
    
    const result = await axios.post(postURL, uploadFormData, config);
    
    // 检查返回结果是否有效
    if (!result || !result.data) {
      throw new Error('图床返回无效数据');
    }
    
    // 兼容不同的API返回格式
    const imageUrl = result.data.data || result.data.url || result.data.link || result.data;
    
    const names = file.name.split(".");
    names.pop();
    const filename = names.join(".");
    const image = {
      filename,
      url: encodeURI(result.data.data),
    };

    if (content) {
      writeToEditor({content, image});
    }
    images.push(image);
    onSuccess(result);
    setTimeout(() => {
      hideUploadNoti();
    }, 500);
  } catch (error) {
    console.error('图片上传失败:', error);
    message.destroy();
    uploadError(error.message || error.toString());
    onError(error, error.toString());
  }
};

// SM.MS存储上传
export const smmsUpload = ({
  formData = new FormData(),
  file = {},
  action = SM_MS_PROXY,
  onProgress = () => {},
  onSuccess = () => {},
  onError = () => {},
  headers = {},
  withCredentials = false,
  images = [],
  content = null, // store content
}) => {
  showUploadNoti();
  
  try {
    // 检查文件是否有效
    if (!file || !file.name) {
      hideUploadNoti();
      const errorMsg = "无效的文件";
      uploadError(errorMsg);
      onError(new Error(errorMsg), errorMsg);
      return;
    }
    
    // 检查文件大小，SM.MS限制为5MB
    if (file.size > 5 * 1024 * 1024) {
      hideUploadNoti();
      const errorMsg = "SM.MS图床限制图片大小不超过5MB";
      uploadError(errorMsg);
      onError(new Error(errorMsg), errorMsg);
      return;
    }
    
    // 检查action是否有效
    if (!action) {
      hideUploadNoti();
      const errorMsg = "SM.MS上传地址无效";
      uploadError(errorMsg);
      onError(new Error(errorMsg), errorMsg);
      return;
    }
    
    // 创建新的FormData对象，避免重用可能已经被修改的formData
    const uploadFormData = new FormData();
    // SM.MS API V2 使用file作为参数名
    uploadFormData.append("file", file);
    
    // 设置超时时间和请求头
    const requestConfig = {
      withCredentials,
      headers: headers || {},
      timeout: 30000, // 30秒超时
      onUploadProgress: function(progressEvent) {
        if (progressEvent && progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(
            {
              percent: percent,
            },
            file,
          );
        }
      },
    };
    
    console.log("开始上传到SM.MS图床", action);
    
    axios
      .post(action, uploadFormData, requestConfig)
      .then(function(response) {
        try {
          if (!response || !response.data) {
            throw new Error("上传响应无效");
          }
          
          const responseData = response.data;
          console.log("SM.MS上传响应:", responseData);
          
          // SM.MS API V2 返回格式处理
          if (responseData.success === false || (responseData.code !== "success" && responseData.code !== 200)) {
            throw new Error(responseData.message || responseData.error || "上传失败");
          }
          
          // API V2 的数据在data字段中
          const imageData = responseData.data || {};
          const image = {
            filename: imageData.filename || file.name,
            url: imageData.url || (imageData.images && imageData.images.url),
          };
          
          // 确保获取到了URL
          if (!image.url) {
            throw new Error("未获取到图片URL");
          }
          
          console.log("SM.MS上传成功，图片URL:", image.url);
          
          if (content) {
            writeToEditor({content, image});
          }
          images.push(image);
          onSuccess(responseData, file);
          setTimeout(function() {
            hideUploadNoti();
          }, 500);
        } catch (error) {
          hideUploadNoti();
          const errorMsg = "处理SM.MS响应出错: " + (error.message || "未知错误");
          console.error(errorMsg, error);
          uploadError(errorMsg);
          onError(error, errorMsg);
        }
      })
      .catch(function(error) {
        hideUploadNoti();
        // 提供更详细的错误信息
        let errorMsg = "图片上传失败";
        
        // 检查是否是网络错误
        if (error.message === "Network Error") {
          errorMsg = "网络连接错误，请检查您的网络连接或者SM.MS服务是否可用";
        } else if (error.response) {
          // 服务器返回了错误状态码
          const responseData = error.response.data || {};
          errorMsg = "服务器错误 (" + (error.response.status || "未知") + "): " + 
                    (responseData.message || responseData.error || error.message || "未知错误");
        } else if (error.request) {
          // 请求发出但没有收到响应
          errorMsg = "服务器没有响应，请稍后重试";
        } else {
          // 其他错误
          errorMsg = error.message || "未知错误";
        }
        
        console.error('SM.MS上传错误:', error);
        uploadError(errorMsg);
        onError(error, errorMsg);
      });
  } catch (error) {
    hideUploadNoti();
    const errorMsg = "SM.MS上传初始化错误: " + (error.message || "未知错误");
    console.error(errorMsg, error);
    uploadError(errorMsg);
    onError(error, errorMsg);
  }
};

// 阿里对象存储，上传部分
const aliOSSPutObject = ({config, file, buffer, onSuccess, onError, images, content}) => {
  let client;
  try {
    client = new OSS(config);
  } catch (error) {
    console.error("OSS客户端创建错误:", error);
    hideUploadNoti();
    uploadError("OSS配置错误，请根据文档检查配置项");
    onError(error, "OSS配置错误，请根据文档检查配置项");
    return;
  }

  const OSSName = getOSSName(file.name);

  client
    .put(OSSName, buffer)
    .then((response) => {
      try {
        const names = file.name.split(".");
        names.pop();
        const filename = names.join(".");
        const image = {
          filename, // 名字不变并且去掉后缀
          url: response.url,
        };
        if (content) {
          writeToEditor({content, image});
        }
        images.push(image);
        onSuccess(response, file);
        setTimeout(() => {
          hideUploadNoti();
        }, 500);
      } catch (err) {
        console.error("处理阿里云上传结果错误:", err);
        hideUploadNoti();
        uploadError("处理上传结果时出错");
        onError(err, err.toString());
      }
    })
    .catch((error) => {
      console.error("阿里云上传错误:", error);
      hideUploadNoti();
      uploadError("阿里云上传失败: " + (error.message || "请根据文档检查配置项"));
      onError(error, error.toString());
    });
};

// 阿里云对象存储上传，处理部分
export const aliOSSUpload = ({
  file = {},
  onSuccess = () => {},
  onError = () => {},
  images = [],
  content = null, // store content
}) => {
  showUploadNoti();
  let config = {};
  try {
    // 安全地解析JSON配置
    try {
      config = JSON.parse(window.localStorage.getItem(ALIOSS_IMAGE_HOSTING) || '{}');
    } catch (e) {
      console.error("阿里云配置解析错误:", e);
      throw new Error("阿里云配置格式错误，请重新配置");
    }
    
    // 检查配置是否完整
    if (!config.region || !config.accessKeyId || !config.accessKeySecret || !config.bucket) {
      throw new Error("阿里云配置不完整，请检查配置");
    }
    
    const base64Reader = new FileReader();
    base64Reader.readAsDataURL(file);
    
    base64Reader.onload = (e) => {
      try {
        const urlData = e.target.result;
        const base64 = urlData.split(",").pop();
        const fileType = urlData
          .split(";")
          .shift()
          .split(":")
          .pop();

        // base64转blob
        const blob = toBlob(base64, fileType);

        // blob转arrayBuffer
        const bufferReader = new FileReader();
        bufferReader.readAsArrayBuffer(blob);
        bufferReader.onload = (event) => {
          try {
            const buffer = new OSS.Buffer(event.target.result);
            aliOSSPutObject({config, file, buffer, onSuccess, onError, images, content});
          } catch (err) {
            console.error("处理文件缓冲区错误:", err);
            hideUploadNoti();
            uploadError("处理文件时出错");
            onError(err, err.toString());
          }
        };
        
        bufferReader.onerror = (err) => {
          console.error("读取文件缓冲区错误:", err);
          hideUploadNoti();
          uploadError("读取文件时出错");
          onError(err, err.toString());
        };
      } catch (err) {
        console.error("处理文件数据错误:", err);
        hideUploadNoti();
        uploadError("处理文件数据时出错");
        onError(err, err.toString());
      }
    };
    
    base64Reader.onerror = (err) => {
      console.error("读取文件错误:", err);
      hideUploadNoti();
      uploadError("读取文件时出错");
      onError(err, err.toString());
    };
  } catch (error) {
    console.error("阿里云上传初始化错误:", error);
    hideUploadNoti();
    uploadError(error.message || "阿里云上传配置错误");
    onError(error, error.toString());
  }
};

// Gitee存储上传
export const giteeUpload = ({
  formData = new FormData(),
  file = {},
  onProgress = () => {},
  onSuccess = () => {},
  onError = () => {},
  headers = {},
  withCredentials = false,
  images = [],
  content = null, // store content
}) => {
  showUploadNoti();

  if (file.size / 1024 / 1024 > 1) {
    message.warn("有图片超过 1 MB，无法使用");
  }

  const config = JSON.parse(window.localStorage.getItem(GITEE_IMAGE_HOSTING));

  const base64Reader = new FileReader();
  base64Reader.readAsDataURL(file);
  base64Reader.onload = (e) => {
    const urlData = e.target.result;
    const base64 = urlData.split(",").pop();

    const date = new Date();
    const seperator = "-";
    const dir = date.getFullYear() + seperator + (date.getMonth() + 1) + seperator + date.getDate();

    const dateFilename = new Date().getTime() + "-" + file.name;
    const url = `https://gitee.com/api/v5/repos/${config.username}/${config.repo}/contents/${dir}/${dateFilename}`;

    formData.append("content", base64);
    formData.append("access_token", config.token);
    formData.append("message", "mdnice upload picture");

    axios
      .post(url, formData, {
        withCredentials,
        headers,
        onUploadProgress: ({total, loaded}) => {
          onProgress(
            {
              percent: parseInt(Math.round((loaded / total) * 100).toFixed(2), 10),
            },
            file,
          );
        },
      })
      .then(({data: response}) => {
        if (response.code === "exception") {
          throw response.message;
        }
        const names = file.name.split(".");
        names.pop();
        const filename = names.join(".");
        const image = {
          filename,
          url: response.content.download_url,
        };
        if (content) {
          writeToEditor({content, image});
        }
        images.push(image);
        onSuccess(response, file);
        setTimeout(() => {
          hideUploadNoti();
        }, 500);
      })
      .catch((error) => {
        hideUploadNoti();
        let errorMsg = "Gitee图片上传失败: " + (error.toString() + " 可能存在图片名重复等问题");
        console.error('Gitee上传错误:', error);
        uploadError(errorMsg);
        onError(error, errorMsg);
      });
  };
};

// GitHub存储上传
export const githubUpload = ({
  formData = new FormData(),
  file = {},
  onProgress = () => {},
  onSuccess = () => {},
  onError = () => {},
  headers = {},
  withCredentials = false,
  images = [],
  content = null, // store content
}) => {
  showUploadNoti();

  const config = JSON.parse(window.localStorage.getItem(GITHUB_IMAGE_HOSTING));

  // 检查配置是否完整
  if (!config.username || !config.repo || !config.token) {
    hideUploadNoti();
    uploadError("GitHub配置不完整，请检查配置");
    onError(new Error("GitHub配置不完整"), "GitHub配置不完整，请检查配置");
    return;
  }

  const base64Reader = new FileReader();
  base64Reader.readAsDataURL(file);
  base64Reader.onload = (e) => {
    const urlData = e.target.result;
    const base64 = urlData.split(",").pop();

    const date = new Date();
    const seperator = "-";
    const dir = date.getFullYear() + seperator + (date.getMonth() + 1) + seperator + date.getDate();

    const dateFilename = new Date().getTime() + "-" + file.name;
    // 不在URL中使用token，而是在请求头中使用
    const url = `https://api.github.com/repos/${config.username}/${config.repo}/contents/${dir}/${dateFilename}`;

    const data = {
      content: base64,
      message: "mdnice upload picture",
    };

    // 设置认证头
    const requestHeaders = {
      ...headers,
      Authorization: `token ${config.token}`,
    };

    axios
      .put(url, data, {
        withCredentials,
        headers: requestHeaders,
        timeout: 30000, // 30秒超时
        onUploadProgress: ({total, loaded}) => {
          onProgress(
            {
              percent: parseInt(Math.round((loaded / total) * 100).toFixed(2), 10),
            },
            file,
          );
        },
      })
      .then(function(response) {
        try {
          if (!response || !response.data) {
            throw new Error("上传响应无效");
          }
          
          const responseData = response.data;
          
          if (responseData.code === "exception") {
            throw new Error(responseData.message || "上传异常");
          }
          
          const names = file.name.split(".");
          names.pop();
          const filename = names.join(".");

          // 安全地构建URL
          let imageUrl;
          try {
            if (config.jsdelivr === "true") {
              imageUrl = "https://cdn.jsdelivr.net/gh/" + config.username + "/" + config.repo + "/" + dir + "/" + dateFilename;
            } else {
              if (responseData.content && responseData.content.download_url) {
                imageUrl = responseData.content.download_url;
              } else {
                throw new Error("无法获取图片URL");
              }
            }
          } catch (urlError) {
            console.error("构建图片URL错误:", urlError);
            throw new Error("无法构建图片URL: " + urlError.message);
          }

          const image = {
            filename,
            url: imageUrl,
          };
          
          if (content) {
            writeToEditor({content, image});
          }
          
          images.push(image);
          onSuccess(responseData, file);
          
          setTimeout(function() {
            hideUploadNoti();
          }, 500);
        } catch (error) {
          hideUploadNoti();
          const errorMsg = "处理GitHub响应出错: " + (error.message || "未知错误");
          console.error(errorMsg, error);
          uploadError(errorMsg);
          onError(error, errorMsg);
        }
      })
      .catch(function(error) {
        hideUploadNoti();
        let errorMsg = "GitHub图片上传失败";
        
        // 检查是否是网络错误
        if (error.message === "Network Error") {
          errorMsg = "网络连接错误，请检查您的网络连接或者GitHub服务是否可用";
        } else if (error.response) {
          // 服务器返回了错误状态码
          const status = error.response.status || "未知";
          const message = (error.response.data && error.response.data.message) || error.message || "未知错误";
          errorMsg = "GitHub服务器错误 (" + status + "): " + message;
        } else if (error.request) {
          // 请求发出但没有收到响应
          errorMsg = "GitHub服务器没有响应，请稍后重试";
        }
        
        console.error('GitHub上传错误:', error);
        uploadError(errorMsg);
        onError(error, errorMsg);
      });
  };
};

// 自动检测上传配置，进行上传
export const uploadAdaptor = (...args) => {
  let params = {};
  try {
    // 提取参数
    params = args[0] || {};
    const { onError } = params;
    
    // 安全地获取图床类型
    let type;
    try {
      type = localStorage.getItem(IMAGE_HOSTING_TYPE); // SM.MS | 阿里云 | 七牛云 | Gitee | GitHub | 用户自定义图床
    } catch (e) {
      console.error("获取图床类型失败:", e);
      // 如果无法访问localStorage，使用默认图床
      message.info("无法获取图床配置，默认使用SM.MS图床");
      return smmsUpload(...args);
    }
    
    // 安全地获取用户自定义图床名称
    const userType = imageHosting && imageHosting.hostingName;
    
    console.log("当前选择的图床类型:", type);
    
    // 如果没有选择图床类型，默认使用SM.MS
    if (!type) {
      message.info("未选择图床类型，默认使用SM.MS图床");
      return smmsUpload(...args);
    }
    
    // 用户自定义图床
    if (type === userType) {
      // 检查用户自定义图床配置
      if (!imageHosting || !imageHosting.hostingUrl) {
        const errorMsg = "请先配置自定义图床URL";
        message.error(errorMsg);
        if (onError) onError(new Error(errorMsg), errorMsg);
        return false;
      }
      return customImageUpload(...args);
    } 
    // SM.MS图床
    else if (type === IMAGE_HOSTING_NAMES.smms) {
      return smmsUpload(...args);
    } 
    // 七牛云图床
    else if (type === IMAGE_HOSTING_NAMES.qiniuyun) {
      let config = {};
      try {
        const configStr = window.localStorage.getItem(QINIUOSS_IMAGE_HOSTING);
        config = configStr ? JSON.parse(configStr) : {};
      } catch (e) {
        console.error("七牛云配置解析错误:", e);
        const errorMsg = "七牛云配置格式错误，请重新配置";
        message.error(errorMsg);
        if (onError) onError(e, errorMsg);
        return false;
      }
      
      if (
        !config || 
        !config.accessKey ||
        !config.secretKey ||
        !config.bucket ||
        !config.domain
      ) {
        const errorMsg = "请先完整配置七牛云图床";
        message.error(errorMsg);
        if (onError) onError(new Error(errorMsg), errorMsg);
        return false;
      }
      return qiniuOSSUpload(...args);
    } 
    // 阿里云图床
    else if (type === IMAGE_HOSTING_NAMES.aliyun) {
      let config = {};
      try {
        const configStr = window.localStorage.getItem(ALIOSS_IMAGE_HOSTING);
        config = configStr ? JSON.parse(configStr) : {};
      } catch (e) {
        console.error("阿里云配置解析错误:", e);
        const errorMsg = "阿里云配置格式错误，请重新配置";
        message.error(errorMsg);
        if (onError) onError(e, errorMsg);
        return false;
      }
      
      if (
        !config ||
        !config.region ||
        !config.accessKeyId ||
        !config.accessKeySecret ||
        !config.bucket
      ) {
        const errorMsg = "请先完整配置阿里云图床";
        message.error(errorMsg);
        if (onError) onError(new Error(errorMsg), errorMsg);
        return false;
      }
      return aliOSSUpload(...args);
    } 
    // Gitee图床
    else if (type === IMAGE_HOSTING_NAMES.gitee) {
      let config = {};
      try {
        const configStr = window.localStorage.getItem(GITEE_IMAGE_HOSTING);
        config = configStr ? JSON.parse(configStr) : {};
      } catch (e) {
        console.error("Gitee配置解析错误:", e);
        const errorMsg = "Gitee配置格式错误，请重新配置";
        message.error(errorMsg);
        if (onError) onError(e, errorMsg);
        return false;
      }
      
      if (!config || !config.username || !config.repo || !config.token) {
        const errorMsg = "请先完整配置 Gitee 图床";
        message.error(errorMsg);
        if (onError) onError(new Error(errorMsg), errorMsg);
        return false;
      }
      return giteeUpload(...args);
    } 
    // GitHub图床
    else if (type === IMAGE_HOSTING_NAMES.github) {
      let config = {};
      try {
        const configStr = window.localStorage.getItem(GITHUB_IMAGE_HOSTING);
        config = configStr ? JSON.parse(configStr) : {};
      } catch (e) {
        console.error("GitHub配置解析错误:", e);
        const errorMsg = "GitHub配置格式错误，请重新配置";
        message.error(errorMsg);
        if (onError) onError(e, errorMsg);
        return false;
      }
      
      if (!config || !config.username || !config.repo || !config.token) {
        const errorMsg = "请先完整配置 GitHub 图床";
        message.error(errorMsg);
        if (onError) onError(new Error(errorMsg), errorMsg);
        return false;
      }
      return githubUpload(...args);
    } else {
      // 未知图床类型，默认使用SM.MS
      const infoMsg = "未知图床类型，默认使用SM.MS图床";
      message.info(infoMsg);
      return smmsUpload(...args);
    }
  } catch (error) {
    console.error("图床适配器错误:", error);
    const errorMsg = "图床配置错误，请检查配置或重新选择图床";
    message.error(errorMsg);
    if (params && params.onError) params.onError(error, errorMsg);
    return false;
  }
};
