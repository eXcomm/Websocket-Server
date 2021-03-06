/**
 * Node JS Websocket Media Processing Server By Nick Blackwell. 
 * 
 * requires node libraries: ws, fs, child_process and uses ffmpeg from command line
 * this has been developed on a redhat linux server and ffmpeg is executed like this: /usr/local/bin/ffmpeg ... 
 * this will likely need to be changed for your system
 * 
 * This tool provides a command line like interface for websocket clients. 
 * and provides a few services depending on the command given by the client. 
 * 
 * 	on successful connection, the servers first response id a unique id [client id] for the client. 
 *  this is important if the client application uses multiple websockets and intends to share data. see 'websocket pair commands' below
 * 
 * 	commands:
 * 
 * 		begin audioupload [options] 		
 * 				prepares server to receive an audio file (.wav)
 * 
 * 		begin captureaudiosamples [options] 
 * 				NOT IMPLEMENTED // prepares server to receive audio sample stream, 
 * 				client should define channels, samplerate, bits per sample, endian-ness - (assumes pcm stream)
 * 
 * 		begin captureimageframes [options: -mime jpg/png]
 * 				prepares server to receive video image frames as png or jpg 
 * 				client should then send sequential images as Blobs image/[jpg|png]
 * 				the client can decide the quality and size of the images it is sending 
 * 
 * 		end 
 * 				signals the end of any command starting with 'begin'. 
 * 
 * 		export [options] 
 * 				only available to client websocket after: 'begin captureimageframes' [...frames...] 'end'
 * 				sever transcodes video (and audio if available) into mp4 (TODO or webm, ogv) and sends back to client as Blob video/[mp4|...]
 * 
 * 		
 * 	example: single socket audio video pseudo-code. 
 * 
 * 		create socket. 
 * 		start audio recorder.
 * 		send: 'begin captureimageframes'
 * 		start video processing loop (draw video to blob) 
 * 
 * 		...
 * 		send [Blob image]
 * 		send [Blob image]
 * 		send [Blob image]
 * 		...
 * 
 * 		(finished) stop looping and convert audio to .wav blob
 * 
 * 		send: 'end'
 * 		send: 'begin audioupload'
 * 		send: [Blob audio]
 * 		send: 'end'
 * 		send: 'export'
 * 		
 * 		recieve: [Blob video]
 * 	
 * 		
 * 
 * 
 * 	websocket pair commands:
 * 
 * 		give audio to [client id]
 * 		accept audio from [client id] 
 * 
 * 				the order of these commands does not matter, however, both commands must be completed before access 
 * 				will be given to the acceptor
 * 				
 * 				if client A records video and client B records audio then: 
 * 				client A sends: 'accept audio from B' 
 * 				and client B sends: 'give audio to A' 
 * 				then when client A performs any export command (only A can export since only A has video content)
 * 				it will be able to use the audio from B. 
 * 
 * 				multiple WebSockets can be used by a single client, for example: one for video and one for audio. 
 * 				this allows both sockets to stream data simultaneously. 
 * 				
 * 
 * @author Nick Blackwell https://people.ok.ubc.ca/nblackwe
 *
 * 
 */
(function(port){
	//create the websocket server and start running.
	var WebSocketServer = require('ws').Server;
	var wss = new WebSocketServer({port: port});

	//include filesystem now, used later
	var fs=require('fs');
	var shell = require('child_process');

	//initialize client id, counter
	var client=0; 

	var folderName=function(i){
		return 'client_'+('0000000'+i).slice(-7);
	};


	//remove all folders that where created from any previous server instances.
	var cleanup=function(){

		var i=0, recurse=false;
		if(arguments.length){
			i=arguments[0];
		}else{
			recurse=true;
		}

		var folder=folderName(i);

		fs.exists(folder, (function(folder){ 
			return function (exists) {
				if(exists){
					fs.readdir(folder,function(err, files){
						if(err){
							console.log('Error reading dir: '+folder);
						}else{
							files.forEach(function(f){
								fs.unlink(folder+'/'+f,function(err){
									if(err){
										throw err;
									}else{
										//console.log('Deleted: '+folder+'/'+f);
										//too much logging...
									}
								});
							});

							fs.rmdir(folder,function(err){
								if(err){
									throw err;
								}else{
									console.log((recurse?'':(i+': '))+'Deleted: '+folder+'/');
								}
							});
							if(recurse===true){
								cleanup(i+1);
							}
						}
					});

				}
			}; 
		})(folder));

	};
	cleanup(); //need to empty folders

	var clients={};
	var getClientParam=function(cid, param, defaultValue){

		if(clients["_"+cid]){
			var c=clients["_"+cid].config();
			if(c[param]){
				return c[param];
			}
		}

		return defaultValue;
	};

	wss.on('connection', function(ws) {


		var clientMode=['command']; 
		var clientConfig=[{}];

		var mode=function(){
			return clientMode[clientMode.length-1];
		};


		var config=function(){
			return clientConfig[clientConfig.length-1];
		};

		var emptyHandler=function(data){
			console.log((cid)+': discarded binary data, empty handler');
		};




		var dataHandler=emptyHandler;

		var cid=client; //this is the current connections id.
		client++; //increment for other connections

		clients['_'+cid]={

				config:config,
				mode:mode,
				ws:ws

		};

		var clientsfolder=folderName(cid);

		fs.mkdir(clientsfolder);

		console.log('Connected Client: '+(cid)+', with folder: '+clientsfolder+'. mode: '+mode());


		var process=function(data, flags){
			if(flags){
				if(flags.binary){  

					dataHandler(data);

				}else{
					console.log((cid)+': '+data);

					if(mode()==='command'){

						//basically want to support a number of data stream types, 
						//for html5 it is not possible(?) to stream encoded video data, so support
						//for image frames is necessary

						if(data.indexOf('begin captureimageframes')===0){

							//arguments should be parsed from data, eg data might be: 'begin captureimageframes -mime png'
							var d={
								ext:'png'
							};
							data.split(' -').forEach(function(s){
								
								if(s.indexOf('mime ')===0){
									var m=s.split(' ');
									if(m.length==2&&(['png', 'jpg']).indexOf(m[1])>=0){
										d.ext=m[1];
									}
								}
								
							});

							clientMode.push('captureimageframes');
							clientConfig.push(d);
							dataHandler=(function(){ 
								var i=1;
								return function(data){
									var opts=config();
									fs.writeFile(clientsfolder+'/f_'+('000000'+(i++)).slice(-6)+'.'+opts.ext, data, function (err) {
										if (err) throw err;
									});	
								}; 
							})();

							console.log((cid)+': mode: '+mode());

						}else if(data.indexOf('begin audioupload')===0){

							//arguments should be parsed from data, eg data might be: 'begin captureimageframes -fps 10 -mime png'

							clientMode.push('audioupload');
							clientConfig.push({
								ext:"wav"
							});
							dataHandler=(function(){ 
								var i=1;
								return function(data){
									var opts=config();
									fs.writeFile(clientsfolder+'/a_'+('000'+(i++)).slice(-3)+'.'+opts.ext, data, function (err) {
										if (err) throw err;
									});	
								}; 
							})();

							console.log((cid)+': mode: '+mode());

						}else if(data.indexOf('begin captureaudiosamples')===0){

							//arguments should be parsed from data, eg data might be: 'begin captureaudiosamples -f pcm -r 16000 -b 16 -stereo -le'

							clientMode.push('captureaudiosamples');
							clientConfig.push({
								ext:"pcm",
								rate:16000,
								bits:16,
								mono:false
							});
							dataHandler=(function(){ 
								//TODO: should write linear pcm values to file and later append wav header...
							})();

							console.log((cid)+': mode: '+mode());

						}else if(data.indexOf('export')===0){
							ws.send('begining transcode');
							var out=clientsfolder+'/out.mp4';
							
							var encodeVideo=function(cmd){
								
								shell.exec(cmd, function (error, stdout, stderr) {
									
									console.log((cid)+': shell.exec: '+cmd+' >> ');
									//console.log((cid)+': stdout: '+stdout);
									//console.log((cid)+': stderr: '+stderr);
									if (error !== null) {
										console.log((cid)+': exec error: ' + error);
									}
	
	
									fs.exists(out, function(exists){
										if(exists){
											
											
											var sendBlob=function(file){
												fs.readFile(file, function (err, data) {
	
													if (err) {
														throw err;
													}
													ws.send(data, function(){
	
														fs.readdir(clientsfolder,function(err, files){
															if(err){
																console.log('Error reading dir: '+clientsfolder);
															}else{
																files.forEach(function(f){
																	fs.unlink(clientsfolder+'/'+f,function(err){
																		if(err){
																			throw err;
																		}else{
																			//console.log('Deleted: '+folder+'/'+f);
																			//too much logging...
																		}
																	});
																});
															}
														});
	
	
													});
												});
											};
											
											ws.send('...');
											var audioIn=clientsfolder+'/a_001.wav';
											fs.exists(audioIn, function(exists){
												
												if(exists){
													ws.send('finished transcode');
													var outav=clientsfolder+'/avout.mp4';
													
													var cmd='/usr/local/bin/ffmpeg -i '+out+' -i '+audioIn+' -c:v copy -c:a aac -strict experimental '+outav;
													
													shell.exec(cmd, function (error, stdout, stderr) {
														console.log((cid)+': shell.exec: '+cmd+' >> ');
														//console.log((cid)+': stdout: '+stdout);
														//console.log((cid)+': stderr: '+stderr);
														if (error !== null) {
															console.log((cid)+': exec error: ' + error);
														}
	
	
														fs.exists(outav, function(exists){								
															sendBlob(outav);
															
														});
													});
													
												}else{
													ws.send('finished transcode without audio');
													sendBlob(out);
												}
												
												
											});
											
											
											
											
											
										}else{
											ws.send('transcode error: no output');
										}
									});
	
	
	
								});
							};
							
							fs.exists(clientsfolder+'/f_000001.png',function(exists){
								if(exists){
									ws.send('transcoder detected png list');
									//encode video from png images
									var cmd='/usr/local/bin/ffmpeg -framerate 10 -i '+clientsfolder+'/f_%06d.png -c:v libx264 -r 30 -pix_fmt yuv420p '+out;
									encodeVideo(cmd);
								}else{
									fs.exists(clientsfolder+'/f_000001.jpg', function(exists){
										if(exists){
											ws.send('transcoder detected jpg list');
											//encode video from jpg images
											var cmd='/usr/local/bin/ffmpeg -framerate 10 -i '+clientsfolder+'/f_%06d.jpg -c:v libx264 -r 30 -pix_fmt yuv420p '+out;
											encodeVideo(cmd);
										}else{
											console.log((cid)+': transcode error, did not find png, or jpg images');
										}
									});
								}
							});

						}else if(data.indexOf('accept audio from')===0){

							var socketid=parseInt((data.substring(17)).replace(/^\s+|\s+$/g, ''));
							ws.send((cid)+': accepts audio from '+socketid);
							config()['accepts audio from '+socketid]=true;
							
							if(getClientParam(socketid, 'gives audio to '+cid)===true){
								
								
								fs.rename(folderName(socketid)+'/a_001.wav', clientsfolder+'/a_001.wav', function(err){
									if(err){
										throw err;
									}
									ws.send((cid)+': '+socketid+' gave audio');
									
								});
								
							}

						}else if(data.indexOf('give audio to')===0){

							var socketid=parseInt((data.substring(13)).replace(/^\s+|\s+$/g, ''));
							ws.send((cid)+': gives audio to '+socketid);
							config()['gives audio to '+socketid]=true;
							
							if(getClientParam(socketid, 'accepts audio from '+cid)===true){
								
								fs.rename(clientsfolder+'/a_001.wav', folderName(socketid)+'/a_001.wav', function(err){
									if(err){
										throw err;
									}
									ws.send((cid)+': '+socketid+' accepted audio');
									
								});
								
							}
							
						}



					}else{

						if(data==='end'){

							clientMode.pop();
							clientConfig.pop();
							dataHandler=emptyHandler;

							console.log((cid)+': mode: '+mode());

						}

					}



				}

			}else{
				//this doesn't happen... 
				console.log(data);
			}
		};


		ws.on('message', process);
		ws.send(""+cid);

		ws.on('close',function(code, message){

			console.log((cid)+': Closed Connection: '+code+' '+message);
			cleanup(cid);
			delete clients['_'+cid];
		});
	});

})(process.argv.length&&(!isNaN(process.argv[0]))?process.argv[0]:8080);
