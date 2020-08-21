echo "Hi.. My First GIT Jenkins File"

echo "Pipeline  !!"

pipeline {
    agent { label 'Jenkins2' }
    
    stages {
        stage ( 'Fist Pipeline Project ') {
            agent { label 'Jenkins2' }
            
            steps {
            echo " Hello All !!!"
            echo " This is first pipeline Project"
        
        }
    }
        }
        
        
}
