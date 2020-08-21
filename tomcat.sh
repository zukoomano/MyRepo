yum install wget -y
wget http://apachemirror.wuchna.com/tomcat/tomcat-8/v8.5.50/bin/apache-tomcat-8.5.50.tar.gz
tar -xvzf apache-tomcat-8.5.50.tar.gz
cd apache-tomcat-8.5.50/bin/
chmod +x shutdown.sh
chmod +x startup.sh
./startup.sh 
