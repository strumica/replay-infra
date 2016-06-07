// requires
var mongoose = require('mongoose'),
    fs = require('fs'),
    promise = require('bluebird')
    mkdirp = require('mkdirp'),
    StreamingSource = require('./schemas/StreamingSource'),
    FFmpegService = require('./services/FFmpegWrapper'),
    Event = require('./services/EventEmitterSingleton'),
    FileWatcher = require('./services/FileWatcher')(),
    StreamListener = require('./services/StreamListener')(),
    StreamingSourceDAL = require('./services/StreamingSourceDAL')(process.env.MONGO_HOST,process.env.MONGO_PORT,process.env.MONGO_DATABASE),
    moment = require('moment');

const DURATION = 10,
    TIMER_INTERVAL = 5000;

module.exports = function() {
    console.log("Video recorder service is up.");
    console.log('#MainRoutine# Mongo host:', process.env.MONGO_HOST);
    console.log('#MainRoutine# Mongo port:', process.env.MONGO_PORT);
    console.log('#MainRoutine# Mongo database:', process.env.MONGO_DATABASE);
    console.log('#MainRoutine# Files storage path: ', process.env.STORAGE_PATH);

    // index used to find my StreamingSource object in the DB collection
    var StreamingSourceIndex = process.env.INDEX;

    StreamingSourceDAL.GetStreamingSource(StreamingSourceIndex)
        .then(handleVideoSavingProcess)
        .catch(function(err) {
            if (err) 
                console.log(err);
        });
};

/********************************************************************************************************************************************/
/*                                                                                                                                          */
/*    Here all the process begin to run.                                                                                                    */
/*    first he will listen to the address, when he catch data streaming he will run the ffmpeg command and file watcher.                    */
/*    when the ffmpeg finish his progress or the file watcher see that the file is not get bigger it will start the whole process again.    */
/*                                                                                                                                          */
/********************************************************************************************************************************************/
function handleVideoSavingProcess(StreamingSource) {

    var FileWatcherTimer,
        StreamStatusTimer,
        command;

    console.log('#MainRoutine# Start listen to port: ' + StreamingSource.SourcePort); // still not finished.

    // Starting Listen to the address.
    startStreamListener(StreamingSource,function(){
        StreamStatusTimer = setStatusTimer(StreamStatusTimer,StreamingSourceDAL.NotifySourceListening(StreamingSource.SourceID));
    }); 

    /******************************************/
    /*                                        */
    /*         Events Section:                */
    /*                                        */
    /******************************************/

    // When Error eccured in one of the services.
    Event.on('error', function(err) {        
        // TODO: Handle the error.
        console.log("Error: " + err);
        if (command) {
            promise.resolve()
            .then(function(){
                command.kill('SIGKILL');
            })
            .then(function(){
                FileWatcher.StopWatchFile(FileWatcherTimer);               
                startStreamListener(StreamingSource,function(){
                    StreamStatusTimer = setStatusTimer(StreamStatusTimer,StreamingSourceDAL.NotifySourceListening(StreamingSource.SourceID));
                });              
            });
        }
    });

    // When the StreamListenerService found some streaming data in the address.
    Event.on('StreamingData', function() {
        var CurrentPath = pathBuilder({ SourceName: StreamingSource.SourceName });
        // check if the path is exist (path e.g. 'STORAGE_PATH/SourceID/CurrentDate(dd-mm-yyyy)/')
        try {
            console.log('#MainRoutine# Check if the path: ', CurrentPath, ' exist...');
            fs.accessSync(CurrentPath, fs.F_OK);
            console.log('#MainRoutine# The path is exist');
        } catch (err) {
            // when path not exist
            console.log('#MainRoutine# The path not exist...');
            // create a new path
            mkdirp.sync(CurrentPath);
            console.log('#MainRoutine# new path create at: ', CurrentPath);
        }

        var now = getCurrentTime();

        // TMP:
        var hardcodedParameters = {
            inputs: ['udp://'+StreamingSource.SourceIP+':'+StreamingSource.SourcePort],
            duration: DURATION,
            dir: CurrentPath,
            file: now
        }

        // var ffmepgParams = {
        //     inputs: ['udp://' + StreamingSource.SourceIP + ':' + StreamingSource.SourcePort],
        //     duration: CONST_BLA,
        //     dir: CurrentPath,
        //     file: now
        // }

        // starting the ffmpeg process
        console.log('#MainRoutine# Record new video at: ', CurrentPath);

        FFmpegService.captureMuxedVideoTelemetry(hardcodedParameters)
            .then(function(res) {
                command = res;
                // CurrentPath += '/' + now + '.mp4';

            }, function(rej) {
                // TODO...
            });
        StreamStatusTimer = setStatusTimer(StreamStatusTimer, StreamingSourceDAL.NotifySourceCapturing(StreamingSource.SourceID));                
    });

    // Start file watcher on data start flowing
    Event.on('CapturingBegan', function(filePath) {
     // start to watch the file that the ffmpeg will create
     FileWatcherTimer = FileWatcher.StartWatchFile({ Path: filePath });
    });

    // when FFmpeg done his progress
    Event.on('FFmpegDone', function() {
        promise.resolve()
        .then(function(){
            // Stop the file watcher.
            console.log('#MainRoutine# ffmpeg done his progress.');
            FileWatcher.StopWatchFile(FileWatcherTimer);
        })
        .then(function(){
            // Start the whole process again by listening to the address again.
            console.log('#MainRoutine# Start to listen the address again');
            startStreamListener(StreamingSource,function(){
                StreamStatusTimer = setStatusTimer(StreamStatusTimer,StreamingSourceDAL.NotifySourceListening(StreamingSource.SourceID));
            });  
        });
    });

    // When the source stop stream data.
    Event.on('FileWatchStop', function() {
        // kill The FFmpeg Process.
        console.log('#MainRoutine# The Source stop stream data, Killing the ffmpeg process');
        promise.resolve()
        .then(function(){
           command.kill('SIGKILL');           
        })
        .then(function(){
            // Start the whole process again by listening to the address again.
            console.log('#MainRoutine# Start to listen the address again');            
            startStreamListener(StreamingSource,function(){
                StreamStatusTimer = setStatusTimer(StreamStatusTimer,StreamingSourceDAL.NotifySourceListening(StreamingSource.SourceID));
            });             
        });       
    });

    // kill the ffmpeg, will emit when something happen to the node process and we want to clean up things
    Event.on('KillFFmpeg', function(cb) {
        console.log('#MainRoutine# Killing ffmpeg...');
        if (command) {
            command.kill('SIGKILL');
        }
        StreamingSourceDAL.NotifySourceNone(StreamingSource.SourceID);
    });
};

/********************************************************************************************/
/*                                                                                          */
/*                                 Helper Methods                                           */
/*                                                                                          */
/********************************************************************************************/

// build new path in the current date. e.g: STORAGE_PATH/27-05-1996
function pathBuilder(VideoObject) {
    return process.env.STORAGE_PATH + '/' + VideoObject.SourceName + '/' + getCurrentDate();
};

// Sets a keep alive status notifier
function setStatusTimer(timer, method){
    clearInterval(timer);    
    timer = setInterval(function() {
        method;
        console.log('#MainRoutine# updating status....'+ moment().format());
    }, TIMER_INTERVAL);

    return timer;
}

// get the current date and return format of dd-mm-yyyy
function getCurrentDate() {
	var today = new Date(),
		dd = checkTime(today.getDate()),
		mm = checkTime(today.getMonth() + 1), //January is 0!
		yyyy = today.getFullYear();

	return dd + '-' + mm + '-' + yyyy;
};

// get the current time and return format of hh-MM-ss
function getCurrentTime() {
	var today = new Date(),
		h = checkTime(today.getHours()),
		m = checkTime(today.getMinutes()),
		s = checkTime(today.getSeconds());

	return h + '-' + m + '-' + s;
};

// helper method for the getCurrentDate function and for the getCurrentTime function
function checkTime(i) {
	// Check if the num is under 10 to add it 0, e.g : 5 - 05.
	if (i < 10) {
		i = "0" + i;
	}
	return i;
};

// starting Listen to the stream
function startStreamListener(StreamingSource, callback) {

    var StreamListenerParams = {
        Ip: StreamingSource.SourceIP,
        Port: StreamingSource.SourcePort
    }
    StreamListener.StartListen(StreamListenerParams);
    callback();
};

/********************************************************************************************/
/*                                                                                          */
/*                                 Exit Methods                                             */
/*                                                                                          */
/*    This will clean up the ffmpeg process before the node process will close somehow.     */
/*                                                                                          */
/********************************************************************************************/

process.stdin.resume(); // so the program will not close instantly

function exitHandler(options, err) {
	if (options.cleanup)
		Event.emit('KillFFmpeg');
	if (err)
		console.log(err.stack);
	if (options.exit)
		process.exit();
};

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));
// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
// catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));
