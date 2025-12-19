import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.get('/',(req,res)=>{
    res.send("Hello World");
})
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});
let currentPoll = null; // current poll object
let answers={};  // object to store answers
let students=new Map(); 
let teachers=new Map(); // track teachers
let timerInterval=null;  // interval for timer
let timeRemaining=0;    // time remaining for the poll
let chatMessages=[];  // store chat messages
let pollHistory=[];  // store completed poll history
function canCreateNewPoll(){
    if(!currentPoll) return true;
    if(currentPoll.status==="ended"){
        const totalStudents=students.size;
        const totalAnswers=Object.keys(answers).length;
        return totalStudents===totalAnswers;
    }
    return false;
}
function calculateResults(){
    if(!currentPoll) return {};
    const results={};
    currentPoll.options.forEach(option=>{
        results[option]=0;
    });
    Object.values(answers).forEach(answer=>{
        if(results[answer.answer]!==undefined){
            results[answer.answer]++;
        }
    });
    return{
        results:results,
        totalVotes:Object.keys(answers).length,
        totalStudents:students.size
    };
}
function broadcastResults(){
    const results=calculateResults();
    io.emit('results',results);
}
function startTimer(duration){
    if(timerInterval) clearInterval(timerInterval);
    timeRemaining=duration;
    timerInterval=setInterval(()=>{
        timeRemaining--;
        io.emit('timerUpdate',{timeRemaining});
        if(timeRemaining<=0){
            clearInterval(timerInterval);
            endPoll();
        }
    },1000);
}
function endPoll(){
    if(currentPoll){
        currentPoll.status='ended';
        const finalResults=calculateResults();
        
        // Store poll in history
        pollHistory.push({
            question: currentPoll.question,
            options: currentPoll.options,
            correctAnswer: currentPoll.correctAnswer, // Include correct answer in history
            timer: currentPoll.timer,
            createdAt: currentPoll.createdAt,
            endedAt: Date.now(),
            results: finalResults,
            totalStudents: students.size
        });
        
        io.emit('pollEnded',{
            results:finalResults,
            correctAnswer: currentPoll.correctAnswer, // Include correct answer when poll ends
            message:'Poll ended'
        });
        console.log('Poll has ended');
    }
}


io.on('connection', (socket) => {
  console.log(`A user connected with socket ID: ${socket.id}`);
  socket.on('createPoll',(data)=>{
    if(!canCreateNewPoll()){
        socket.emit('error','Cannot create new poll');
        return;
    }
    if(!data.question|| !data.options|| data.options.length<2){
        socket.emit('error','Invalid poll data');
        return;
    }
    currentPoll={
        question:data.question,
        options:data.options,
        correctAnswer:data.correctAnswer || null, // Store the correct answer
        timer:data.timer || 60,
        createdAt:Date.now(),
        status:'active'
    }
    answers={};
    timeRemaining=currentPoll.timer;
    io.emit('pollCreated',{
        question:currentPoll.question,
        options: currentPoll.options,
        correctAnswer: currentPoll.correctAnswer, // Include correct answer
        timer:currentPoll.timer,
        timeRemaining:timeRemaining,
        status:'active'
    });
    console.log('Poll created and broadcasted to all clients');
    startTimer(currentPoll.timer);
    console.log('Poll created successfully');
  })
  socket.on('joinAsStudent',(data)=>{
    if(!data.studentName){
        socket.emit('error',{message:'Student name is required'});
        return;
    }
    students.set(socket.id,{
        studentName:data.studentName,
        connectedAt:Date.now()
    });
    broadcastParticipants();
    if(currentPoll && currentPoll.status==='active'){
        socket.emit('currentPoll',{
            question:currentPoll.question,
            options:currentPoll.options,
            correctAnswer: currentPoll.correctAnswer, // Include correct answer
            timeRemaining:timeRemaining,
            status: currentPoll.status
        });
    }
    console.log(`Students joined the poll: ${data.studentName}`);
  })
  
  // Handle teacher connection
  socket.on('joinAsTeacher',()=>{
    teachers.set(socket.id,{
      connectedAt:Date.now()
    });
    broadcastParticipants();
    console.log(`Teacher joined: ${socket.id}`);
  })
  // check if the poll exist and is active
  socket.on('submitAnswer',(data)=>{
    if(!currentPoll || currentPoll.status!=='active'){
        socket.emit('error',{message:'No active Poll'});
        return;
    }
    // check if student has already answered
    if(answers[socket.id]){
        socket.emit('error',{message:'You have already answered the poll'});
        return;
    }
    //validate answer
    if(!data.answer || !currentPoll.options.includes(data.answer)){
        socket.emit('error',{message:'Invalid answer'});
        return;
    }
    // Get student name
    const student = students.get(socket.id);
    if(!student){
        socket.emit('error',{message:'Please join as student first'});
        return;
    }
    // Store answer
    answers[socket.id]={
        studentName:student.studentName,
        answer:data.answer,
        timestamp:Date.now()
    };
    // Broadcast updated results
    broadcastResults();
    // Check if all students answered
    const allAnswered = students.size > 0 && 
                        Object.keys(answers).length === students.size;
        if(allAnswered){
            currentPoll.status='ended';
            clearInterval(timerInterval);
            const finalResults=calculateResults();
            
            // Store poll in history
            pollHistory.push({
                question: currentPoll.question,
                options: currentPoll.options,
                correctAnswer: currentPoll.correctAnswer, // Include correct answer in history
                timer: currentPoll.timer,
                createdAt: currentPoll.createdAt,
                endedAt: Date.now(),
                results: finalResults,
                totalStudents: students.size
            });
            
            io.emit('pollEnded',{
                results:finalResults,
                correctAnswer: currentPoll.correctAnswer, // Include correct answer when poll ends
                message:'All students have answered'
            });
            console.log('All students have answered');
        }
    console.log(`Answer received from ${student.studentName}: ${data.answer}`);
  })
  
  // Handle getResults request
  socket.on('getResults',()=>{
    const results=calculateResults();
    socket.emit('results',results);
  })
  
  // Chat functionality
  socket.on('sendMessage',(data)=>{
    const message={
      ...data,
      socketId:socket.id,
      timestamp:Date.now()
    };
    chatMessages.push(message);
    // Broadcast to all clients
    io.emit('chatMessage',message);
    console.log(`Message from ${data.sender}: ${data.message}`);
  })
  
  // Get participants
  socket.on('getParticipants',()=>{
    broadcastParticipants();
  })
  
  // Get poll history (teacher only)
  socket.on('getPollHistory',()=>{
    if(teachers.has(socket.id)){
      socket.emit('pollHistory',pollHistory);
      console.log(`Poll history sent to teacher ${socket.id}:`,pollHistory.length,'polls');
    }else{
      socket.emit('error',{message:'Only teachers can view poll history'});
    }
  })
  
  // Kick student (teacher only)
  socket.on('kickStudent',(data)=>{
    if(teachers.has(socket.id)){
      const studentSocket=io.sockets.sockets.get(data.socketId);
      if(studentSocket){
        // Emit kicked event first
        studentSocket.emit('kicked','You have been removed by the teacher');
        // Give a small delay to ensure event is sent before disconnecting
        setTimeout(() => {
          studentSocket.disconnect();
          students.delete(data.socketId);
          delete answers[data.socketId];
          broadcastParticipants();
          console.log(`Student ${data.socketId} was kicked by teacher`);
        }, 100);
      }
    }
  })
  
  // Handle disconnect
  socket.on('disconnect',()=>{
    console.log(`User disconnected: ${socket.id}`);
    students.delete(socket.id);
    teachers.delete(socket.id);
    delete answers[socket.id];
    broadcastParticipants();
  })
  
  function broadcastParticipants(){
    const participants=[];
    // Add teachers
    teachers.forEach((teacher,socketId)=>{
      participants.push({
        socketId,
        name:'Teacher',
        role:'teacher'
      });
    });
    // Add students
    students.forEach((student,socketId)=>{
      participants.push({
        socketId,
        name:student.studentName,
        role:'student'
      });
    });
    io.emit('participantsUpdate',{participants});
  }
});